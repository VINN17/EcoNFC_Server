// ==================== CONFIGURATION ====================
const CONFIG = {
    mqtt: {
        broker: 'broker.hivemq.com',
        port: 8884, // WebSocket port
        protocol: 'wss',
        username: '',
        password: '',
        reconnectPeriod: 5000
    },
    map: {
        defaultCenter: [-6.2088, 106.8456], // Jakarta
        defaultZoom: 12,
        tileLayer: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap contributors'
    },
    storage: {
        devices: 'aqi_devices',
        settings: 'aqi_settings',
        sensorData: 'aqi_sensor_data'
    },
    // Default thresholds
    defaultThresholds: {
        aqi: { warning: 50, danger: 100 },
        temp: { warning: 35, danger: 40 },
        humidity: { warning: 80, danger: 90 },
        mq135: { warning: 400, danger: 600 },
        mq7: { warning: 50, danger: 100 },
        mq9: { warning: 300, danger: 500 }
    }
};

// ==================== STATE MANAGEMENT ====================
const state = {
    devices: [],
    selectedDevice: null,
    mqttClient: null,
    maps: {
        main: null,
        picker: null
    },
    charts: {
        aqi: null,
        tempHum: null,
        gas: null
    },
    selectedLocation: {
        lat: CONFIG.map.defaultCenter[0],
        lng: CONFIG.map.defaultCenter[1]
    },
    editingDevice: null, // For edit mode
    thresholds: null,
    alerts: [],
    sensorDataHistory: [] // Store sensor data for export
};

// ==================== UTILITY FUNCTIONS ====================
const utils = {
    // Generate unique ID
    generateId: () => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    // Format date
    formatDate: (timestamp) => {
        if (!timestamp) return 'Never';
        const date = new Date(timestamp);
        return date.toLocaleString();
    },

    // Format uptime
    formatUptime: (seconds) => {
        if (!seconds) return '--';
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    },

    // Get AQI status
    getAqiStatus: (aqi) => {
        if (aqi < 20) return { text: 'Baik', class: 'aqi-good' };
        if (aqi < 50) return { text: 'Sedang', class: 'aqi-moderate' };
        if (aqi < 100) return { text: 'Tidak Sehat', class: 'aqi-unhealthy' };
        if (aqi < 200) return { text: 'Sangat Tidak Sehat', class: 'aqi-very-unhealthy' };
        return { text: 'Berbahaya', class: 'aqi-hazardous' };
    },

    // Get device status
    getDeviceStatus: (lastUpdate) => {
        if (!lastUpdate) return { text: 'Offline', class: 'status-offline' };
        const now = Date.now();
        const diff = now - lastUpdate;
        if (diff < 60000) return { text: 'Online', class: 'status-online' };
        if (diff < 300000) return { text: 'Warning', class: 'status-warning' };
        return { text: 'Offline', class: 'status-offline' };
    },

    // Show toast notification
    showToast: (message, type = 'success') => {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i>
            <span>${message}</span>
        `;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.remove();
        }, 3000);
    },

    // Export to Excel (CSV format)
    exportToExcel: () => {
        if (state.sensorDataHistory.length === 0) {
            utils.showToast('No data to export', 'error');
            return;
        }

        // Prepare CSV content
        let csv = 'Timestamp,Device Name,Location,AQI,Temperature (°C),Humidity (%),MQ135 (ppm),MQ7 (ppm),MQ9 (ppm)\n';
        
        state.sensorDataHistory.forEach(record => {
            csv += `${utils.formatDate(record.timestamp)},${record.deviceName},${record.location},${record.aqi},${record.temp},${record.humidity},${record.mq135},${record.mq7},${record.mq9}\n`;
        });

        // Create download link
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `sensor_data_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
        URL.revokeObjectURL(url);

        utils.showToast('Data exported successfully!', 'success');
    }
};

// ==================== STORAGE MANAGEMENT ====================
const storage = {
    // Save devices
    saveDevices: () => {
        localStorage.setItem(CONFIG.storage.devices, JSON.stringify(state.devices));
        console.log('Devices saved to localStorage:', state.devices.length);
    },

    // Load devices
    loadDevices: () => {
        const data = localStorage.getItem(CONFIG.storage.devices);
        if (data) {
            state.devices = JSON.parse(data);
            console.log('Devices loaded from localStorage:', state.devices.length);
        }
    },

    // Save settings (thresholds)
    saveSettings: (settings) => {
        localStorage.setItem(CONFIG.storage.settings, JSON.stringify(settings));
        console.log('Settings saved:', settings);
    },

    // Load settings
    loadSettings: () => {
        const data = localStorage.getItem(CONFIG.storage.settings);
        if (data) {
            state.thresholds = JSON.parse(data);
        } else {
            state.thresholds = CONFIG.defaultThresholds;
        }
        return state.thresholds;
    },

    // Save sensor data history
    saveSensorData: (data) => {
        let history = [];
        const stored = localStorage.getItem(CONFIG.storage.sensorData);
        if (stored) {
            history = JSON.parse(stored);
        }
        
        // Add new data
        history.push(data);
        
        // Keep only last 1000 records to prevent localStorage overflow
        if (history.length > 1000) {
            history = history.slice(-1000);
        }
        
        localStorage.setItem(CONFIG.storage.sensorData, JSON.stringify(history));
        state.sensorDataHistory = history;
    },

    // Load sensor data history
    loadSensorData: () => {
        const data = localStorage.getItem(CONFIG.storage.sensorData);
        if (data) {
            state.sensorDataHistory = JSON.parse(data);
        }
    }
};

// ==================== MQTT MANAGEMENT ====================
const mqttManager = {
    // Connect to MQTT broker
    connect: () => {
        const clientId = 'web_' + Math.random().toString(16).substr(2, 8);
        const url = `${CONFIG.mqtt.protocol}://${CONFIG.mqtt.broker}:${CONFIG.mqtt.port}/mqtt`;
        
        console.log('Connecting to MQTT:', url);
        
        try {
            state.mqttClient = mqtt.connect(url, {
                clientId: clientId,
                clean: true,
                reconnectPeriod: CONFIG.mqtt.reconnectPeriod,
                username: CONFIG.mqtt.username || undefined,
                password: CONFIG.mqtt.password || undefined
            });

            state.mqttClient.on('connect', () => {
                console.log('MQTT Connected');
                mqttManager.subscribeToDevices();
            });

            state.mqttClient.on('message', (topic, message) => {
                mqttManager.handleMessage(topic, message);
            });

            state.mqttClient.on('error', (error) => {
                console.error('MQTT Error:', error);
            });
        } catch (error) {
            console.error('MQTT Connection Error:', error);
        }
    },

    // Subscribe to device topics
    subscribeToDevices: () => {
        state.devices.forEach(device => {
            if (device.mqttTopic) {
                state.mqttClient.subscribe(device.mqttTopic);
                console.log('Subscribed to:', device.mqttTopic);
            }
        });
    },

    // Handle incoming MQTT messages
    handleMessage: (topic, message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log('MQTT Message:', topic, data);

            // Find device by topic
            const device = state.devices.find(d => d.mqttTopic === topic);
            if (device) {
                // Update device data
                device.lastData = data;
                device.lastUpdate = Date.now();
                
                // Save sensor data to history
                storage.saveSensorData({
                    timestamp: Date.now(),
                    deviceName: device.deviceName,
                    location: device.locationName,
                    aqi: data.aqi || 0,
                    temp: data.temp || 0,
                    humidity: data.humidity || 0,
                    mq135: data.ppm_MQ135 || 0,
                    mq7: data.ppm_MQ7 || 0,
                    mq9: data.ppm_MQ9 || 0
                });
                
                // Add data point to chart history
                chartManager.addDataPoint(device);
                
                // Update display
                storage.saveDevices();
                ui.updateDashboard();
                ui.updateDevicesTable();
                mapManager.updateMarkers();
                
                // Check for alerts with thresholds
                alertManager.checkThresholds(device, data);
            }
        } catch (error) {
            console.error('Error parsing MQTT message:', error);
        }
    },

    // Disconnect
    disconnect: () => {
        if (state.mqttClient) {
            state.mqttClient.end();
            state.mqttClient = null;
        }
    }
};

// ==================== NOTIFICATION MANAGEMENT ====================
const notificationManager = {
    alerts: [],

    // Add alert
    addAlert: (device, message) => {
        const alert = {
            id: utils.generateId(),
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            message: message,
            aqi: device.lastData?.aqi || 0,
            timestamp: Date.now(),
            read: false
        };

        notificationManager.alerts.unshift(alert);
        
        // Keep only last 50 alerts
        if (notificationManager.alerts.length > 50) {
            notificationManager.alerts = notificationManager.alerts.slice(0, 50);
        }

        notificationManager.updateBadge();
        notificationManager.showToastAlert(alert);
    },

    // Update notification badge
    updateBadge: () => {
        const unreadCount = notificationManager.alerts.filter(a => !a.read).length;
        const badge = document.querySelector('.notification .badge');
        if (badge) {
            badge.textContent = unreadCount;
            if (unreadCount > 0) {
                badge.style.display = 'block';
                badge.classList.add('has-alerts');
            } else {
                badge.style.display = 'none';
                badge.classList.remove('has-alerts');
            }
        }
    },

    // Show toast alert
    showToastAlert: (alert) => {
        const status = utils.getAqiStatus(alert.aqi);
        utils.showToast(`${alert.deviceName}: ${alert.message} (AQI: ${alert.aqi})`, 'warning');
    },

    // Show notification panel
    showPanel: () => {
        let panel = document.getElementById('notificationPanel');
        
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'notificationPanel';
            panel.className = 'notification-panel';
            document.body.appendChild(panel);
        }

        if (notificationManager.alerts.length === 0) {
            panel.innerHTML = `
                <div class="notification-header">
                    <h3>Notifications</h3>
                    <button onclick="notificationManager.closePanel()" class="close-panel">×</button>
                </div>
                <div class="notification-body">
                    <div class="no-notifications">
                        <i class="fas fa-bell-slash"></i>
                        <p>No notifications</p>
                    </div>
                </div>
            `;
        } else {
            const alertsList = notificationManager.alerts.map(alert => {
                const status = utils.getAqiStatus(alert.aqi);
                return `
                    <div class="notification-item ${alert.read ? 'read' : 'unread'}" 
                         onclick="notificationManager.markAsRead('${alert.id}')">
                        <div class="notification-icon ${status.class}">
                            <i class="fas fa-exclamation-circle"></i>
                        </div>
                        <div class="notification-content">
                            <div class="notification-title">${alert.deviceName}</div>
                            <div class="notification-message">${alert.message}</div>
                            <div class="notification-meta">
                                <span>AQI: ${alert.aqi.toFixed(1)}</span>
                                <span>${utils.formatDate(alert.timestamp)}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            panel.innerHTML = `
                <div class="notification-header">
                    <h3>Notifications (${notificationManager.alerts.length})</h3>
                    <div class="notification-actions">
                        <button onclick="notificationManager.markAllAsRead()" class="btn-text">
                            Mark all as read
                        </button>
                        <button onclick="notificationManager.closePanel()" class="close-panel">×</button>
                    </div>
                </div>
                <div class="notification-body">
                    ${alertsList}
                </div>
            `;
        }

        panel.classList.add('active');
    },

    // Close panel
    closePanel: () => {
        const panel = document.getElementById('notificationPanel');
        if (panel) {
            panel.classList.remove('active');
        }
    },

    // Mark as read
    markAsRead: (alertId) => {
        const alert = notificationManager.alerts.find(a => a.id === alertId);
        if (alert) {
            alert.read = true;
            notificationManager.updateBadge();
        }
    },

    // Mark all as read
    markAllAsRead: () => {
        notificationManager.alerts.forEach(a => a.read = true);
        notificationManager.updateBadge();
        notificationManager.showPanel(); // Refresh panel
    }
};

// ==================== ALERT MANAGEMENT ====================
const alertManager = {
    // Check thresholds and trigger alerts
    checkThresholds: (device, data) => {
        const thresholds = state.thresholds || CONFIG.defaultThresholds;
        const alerts = [];

        // Check AQI
        if (data.aqi >= thresholds.aqi.danger) {
            alerts.push(`⚠️ BAHAYA! AQI sangat tinggi: ${data.aqi.toFixed(1)}`);
        } else if (data.aqi >= thresholds.aqi.warning) {
            alerts.push(`⚡ WARNING! AQI tinggi: ${data.aqi.toFixed(1)}`);
        }

        // Check Temperature
        if (data.temp >= thresholds.temp.danger) {
            alerts.push(`⚠️ BAHAYA! Suhu sangat tinggi: ${data.temp}°C`);
        } else if (data.temp >= thresholds.temp.warning) {
            alerts.push(`⚡ WARNING! Suhu tinggi: ${data.temp}°C`);
        }

        // Check Humidity
        if (data.humidity >= thresholds.humidity.danger) {
            alerts.push(`⚠️ BAHAYA! Kelembaban sangat tinggi: ${data.humidity}%`);
        } else if (data.humidity >= thresholds.humidity.warning) {
            alerts.push(`⚡ WARNING! Kelembaban tinggi: ${data.humidity}%`);
        }

        // Check MQ135
        if (data.ppm_MQ135 >= thresholds.mq135.danger) {
            alerts.push(`⚠️ BAHAYA! Gas MQ135: ${data.ppm_MQ135} ppm`);
        } else if (data.ppm_MQ135 >= thresholds.mq135.warning) {
            alerts.push(`⚡ WARNING! Gas MQ135: ${data.ppm_MQ135} ppm`);
        }

        // Show alerts
        if (alerts.length > 0) {
            alerts.forEach(alert => {
                alertManager.showAlert(device.deviceName, alert);
            });
            
            // Update alerts count
            state.alerts.push({
                id: utils.generateId(),
                deviceName: device.deviceName,
                messages: alerts,
                timestamp: Date.now()
            });
            
            ui.updateAlertsCount();
        }
    },

    // Show alert notification
    showAlert: (deviceName, message) => {
        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert-notification';
        alertDiv.innerHTML = `
            <div class="alert-header">
                <strong>${deviceName}</strong>
                <button onclick="this.parentElement.parentElement.remove()">×</button>
            </div>
            <div class="alert-body">${message}</div>
        `;
        
        document.body.appendChild(alertDiv);
        
        // Auto remove after 10 seconds
        setTimeout(() => {
            if (alertDiv.parentElement) {
                alertDiv.remove();
            }
        }, 10000);
    }
};

// ==================== CHART MANAGEMENT ====================
const chartManager = {
    // Initialize charts
    initCharts: () => {
        // Destroy existing charts if any
        if (state.charts.aqi) state.charts.aqi.destroy();
        if (state.charts.tempHum) state.charts.tempHum.destroy();
        if (state.charts.gas) state.charts.gas.destroy();

        // AQI Chart - Trendline
        const aqiCtx = document.getElementById('aqiChart');
        if (aqiCtx) {
            state.charts.aqi = new Chart(aqiCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'AQI',
                        data: [],
                        borderColor: '#4F46E5',
                        backgroundColor: 'rgba(79, 70, 229, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 4,
                        pointHoverRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { 
                            display: true,
                            position: 'top'
                        },
                        tooltip: {
                            mode: 'index',
                            intersect: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'AQI Level'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Time'
                            }
                        }
                    }
                }
            });
        }

        // Temp & Humidity Chart - Trendline
        const tempHumCtx = document.getElementById('tempHumChart');
        if (tempHumCtx) {
            state.charts.tempHum = new Chart(tempHumCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Temperature (°C)',
                            data: [],
                            borderColor: '#EF4444',
                            backgroundColor: 'rgba(239, 68, 68, 0.1)',
                            borderWidth: 2,
                            fill: true,
                            tension: 0.4,
                            yAxisID: 'y',
                            pointRadius: 3,
                            pointHoverRadius: 5
                        },
                        {
                            label: 'Humidity (%)',
                            data: [],
                            borderColor: '#3B82F6',
                            backgroundColor: 'rgba(59, 130, 246, 0.1)',
                            borderWidth: 2,
                            fill: true,
                            tension: 0.4,
                            yAxisID: 'y1',
                            pointRadius: 3,
                            pointHoverRadius: 5
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    plugins: {
                        legend: { 
                            display: true,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            title: {
                                display: true,
                                text: 'Temperature (°C)'
                            }
                        },
                        y1: {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            title: {
                                display: true,
                                text: 'Humidity (%)'
                            },
                            grid: {
                                drawOnChartArea: false
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Time'
                            }
                        }
                    }
                }
            });
        }

        // Gas Chart
        const gasCtx = document.getElementById('gasChart');
        if (gasCtx) {
            state.charts.gas = new Chart(gasCtx, {
                type: 'bar',
                data: {
                    labels: ['MQ135', 'MQ7', 'MQ9'],
                    datasets: [{
                        label: 'Gas Level (ppm)',
                        data: [0, 0, 0],
                        backgroundColor: [
                            'rgba(139, 92, 246, 0.8)',
                            'rgba(245, 158, 11, 0.8)',
                            'rgba(239, 68, 68, 0.8)'
                        ],
                        borderColor: [
                            'rgb(139, 92, 246)',
                            'rgb(245, 158, 11)',
                            'rgb(239, 68, 68)'
                        ],
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { 
                            display: true,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'PPM'
                            }
                        }
                    }
                }
            });
        }

        // Load initial data for selected device
        const selectElem = document.getElementById('analyticsDevice');
        if (selectElem && selectElem.value) {
            const device = state.devices.find(d => d.deviceId === selectElem.value);
            if (device) {
                chartManager.updateCharts(device);
            }
        }
    },

    // Update charts with device data
    updateCharts: (device) => {
        if (!device) return;

        // Generate mock historical data for demonstration
        const now = new Date();
        const timeLabels = [];
        const aqiData = [];
        const tempData = [];
        const humData = [];

        // Generate 24 data points (last 24 hours)
        for (let i = 23; i >= 0; i--) {
            const time = new Date(now - i * 3600000); // 1 hour intervals
            timeLabels.push(time.getHours() + ':00');
            
            // Use current data with some variation for trend
            const baseAqi = device.lastData?.aqi || 10;
            const baseTemp = device.lastData?.temp || 25;
            const baseHum = device.lastData?.humidity || 60;
            
            // Add random variation to create trendline
            aqiData.push(baseAqi + (Math.random() - 0.5) * 10);
            tempData.push(baseTemp + (Math.random() - 0.5) * 3);
            humData.push(baseHum + (Math.random() - 0.5) * 10);
        }

        // Update AQI chart
        if (state.charts.aqi) {
            state.charts.aqi.data.labels = timeLabels;
            state.charts.aqi.data.datasets[0].data = aqiData;
            state.charts.aqi.update();
        }

        // Update Temperature & Humidity chart
        if (state.charts.tempHum) {
            state.charts.tempHum.data.labels = timeLabels;
            state.charts.tempHum.data.datasets[0].data = tempData;
            state.charts.tempHum.data.datasets[1].data = humData;
            state.charts.tempHum.update();
        }

        // Update gas chart with current data
        if (state.charts.gas && device.lastData) {
            state.charts.gas.data.datasets[0].data = [
                device.lastData.ppm_MQ135 || 0,
                device.lastData.ppm_MQ7 || 0,
                device.lastData.ppm_MQ9 || 0
            ];
            state.charts.gas.update();
        }
    },

    // Store real-time data for charts (called when MQTT message received)
    addDataPoint: (device) => {
        if (!device || !device.lastData) return;

        // Initialize history if not exists
        if (!device.dataHistory) {
            device.dataHistory = {
                timestamps: [],
                aqi: [],
                temp: [],
                humidity: []
            };
        }

        // Add new data point
        const now = new Date();
        device.dataHistory.timestamps.push(now.toLocaleTimeString());
        device.dataHistory.aqi.push(device.lastData.aqi || 0);
        device.dataHistory.temp.push(device.lastData.temp || 0);
        device.dataHistory.humidity.push(device.lastData.humidity || 0);

        // Keep only last 24 points
        if (device.dataHistory.timestamps.length > 24) {
            device.dataHistory.timestamps.shift();
            device.dataHistory.aqi.shift();
            device.dataHistory.temp.shift();
            device.dataHistory.humidity.shift();
        }

        // Update charts if this device is currently selected
        const selectElem = document.getElementById('analyticsDevice');
        if (selectElem && selectElem.value === device.deviceId) {
            chartManager.updateChartsRealtime(device);
        }
    },

    // Update charts with real historical data
    updateChartsRealtime: (device) => {
        if (!device || !device.dataHistory) return;

        // Update AQI chart
        if (state.charts.aqi) {
            state.charts.aqi.data.labels = device.dataHistory.timestamps;
            state.charts.aqi.data.datasets[0].data = device.dataHistory.aqi;
            state.charts.aqi.update();
        }

        // Update Temperature & Humidity chart
        if (state.charts.tempHum) {
            state.charts.tempHum.data.labels = device.dataHistory.timestamps;
            state.charts.tempHum.data.datasets[0].data = device.dataHistory.temp;
            state.charts.tempHum.data.datasets[1].data = device.dataHistory.humidity;
            state.charts.tempHum.update();
        }

        // Update gas chart
        if (state.charts.gas && device.lastData) {
            state.charts.gas.data.datasets[0].data = [
                device.lastData.ppm_MQ135 || 0,
                device.lastData.ppm_MQ7 || 0,
                device.lastData.ppm_MQ9 || 0
            ];
            state.charts.gas.update();
        }
    }
};

// ==================== MAP MANAGEMENT ====================
const mapManager = {
    // Initialize main map
    initMainMap: () => {
        if (state.maps.main) return;

        const mapElement = document.getElementById('map');
        if (!mapElement) return;

        state.maps.main = L.map('map').setView(CONFIG.map.defaultCenter, CONFIG.map.defaultZoom);
        
        L.tileLayer(CONFIG.map.tileLayer, {
            attribution: CONFIG.map.attribution
        }).addTo(state.maps.main);

        mapManager.updateMarkers();
    },

    // Initialize location picker map in modal
    initPickerMap: () => {
        // Wait for modal to be visible
        setTimeout(() => {
            const pickerElement = document.getElementById('locationPickerMap');
            if (!pickerElement) return;

            // Remove old map if exists
            if (state.maps.picker) {
                state.maps.picker.remove();
            }

            // Create new map
            state.maps.picker = L.map('locationPickerMap').setView(
                [state.selectedLocation.lat, state.selectedLocation.lng], 
                13
            );
            
            L.tileLayer(CONFIG.map.tileLayer, {
                attribution: CONFIG.map.attribution
            }).addTo(state.maps.picker);

            // Add marker
            const marker = L.marker([state.selectedLocation.lat, state.selectedLocation.lng], {
                draggable: true
            }).addTo(state.maps.picker);

            // Update location when marker is dragged
            marker.on('dragend', (e) => {
                const pos = e.target.getLatLng();
                state.selectedLocation = { lat: pos.lat, lng: pos.lng };
                document.getElementById('selectedCoords').textContent = 
                    `Lat: ${pos.lat.toFixed(6)}, Lng: ${pos.lng.toFixed(6)}`;
            });

            // Update location on map click
            state.maps.picker.on('click', (e) => {
                state.selectedLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
                marker.setLatLng(e.latlng);
                document.getElementById('selectedCoords').textContent = 
                    `Lat: ${e.latlng.lat.toFixed(6)}, Lng: ${e.latlng.lng.toFixed(6)}`;
            });

            document.getElementById('selectedCoords').textContent = 
                `Lat: ${state.selectedLocation.lat.toFixed(6)}, Lng: ${state.selectedLocation.lng.toFixed(6)}`;
        }, 100);
    },

    // Update markers on main map
    updateMarkers: () => {
        if (!state.maps.main) return;

        // Clear existing markers
        state.maps.main.eachLayer((layer) => {
            if (layer instanceof L.Marker) {
                state.maps.main.removeLayer(layer);
            }
        });

        // Add markers for each device
        state.devices.forEach(device => {
            if (device.location) {
                const status = utils.getDeviceStatus(device.lastUpdate);
                const aqi = device.lastData?.aqi || 0;
                const aqiStatus = utils.getAqiStatus(aqi);

                const icon = L.divIcon({
                    className: 'custom-marker',
                    html: `
                        <div class="marker-pin ${aqiStatus.class}">
                            <i class="fas fa-map-marker-alt"></i>
                        </div>
                        <div class="marker-label">${device.deviceName}</div>
                    `,
                    iconSize: [30, 42],
                    iconAnchor: [15, 42]
                });

                const marker = L.marker([device.location.lat, device.location.lng], { icon })
                    .addTo(state.maps.main);

                marker.bindPopup(`
                    <div class="map-popup">
                        <h4>${device.deviceName}</h4>
                        <p><strong>Lokasi:</strong> ${device.locationName}</p>
                        <p><strong>Status:</strong> <span class="device-status ${status.class}">${status.text}</span></p>
                        <p><strong>AQI:</strong> <span class="${aqiStatus.class}">${aqi.toFixed(1)}</span></p>
                        <p><strong>Suhu:</strong> ${device.lastData?.temp || '--'}°C</p>
                        <p><strong>Kelembaban:</strong> ${device.lastData?.humidity || '--'}%</p>
                    </div>
                `);
            }
        });
    }
};

// ==================== CHART MANAGEMENT ====================
const chartManager = {
    // Initialize charts (placeholder - full implementation would go here)
    init: () => {
        console.log('Charts initialized');
    }
};

// ==================== UI MANAGEMENT ====================
const ui = {
    // Initialize UI
    init: () => {
        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const page = item.getAttribute('data-page');
                ui.navigateTo(page);
            });
        });

        // Add device buttons
        document.getElementById('addDeviceBtn')?.addEventListener('click', () => {
            state.editingDevice = null; // Clear edit mode
            ui.openAddDeviceModal();
        });
        document.getElementById('addDeviceBtn2')?.addEventListener('click', () => {
            state.editingDevice = null;
            ui.openAddDeviceModal();
        });

        // Add device form
        document.getElementById('addDeviceForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            if (state.editingDevice) {
                deviceManager.updateDevice();
            } else {
                deviceManager.addDevice();
            }
        });

        // Cancel add device
        document.getElementById('cancelAddDevice')?.addEventListener('click', () => {
            ui.closeModal('addDeviceModal');
        });

        // Generate NFC config
        document.getElementById('generateNfcBtn')?.addEventListener('click', () => {
            deviceManager.generateNfcConfig();
        });

        // NFC modal
        document.getElementById('closeNfcModal')?.addEventListener('click', () => {
            ui.closeModal('nfcConfigModal');
        });
        document.getElementById('copyNfcConfig')?.addEventListener('click', () => {
            const textarea = document.getElementById('nfcConfigJson');
            textarea.select();
            document.execCommand('copy');
            utils.showToast('Configuration copied!', 'success');
        });
        document.getElementById('downloadNfcConfig')?.addEventListener('click', () => {
            deviceManager.downloadNfcConfig();
        });

        // Device detail modal
        document.getElementById('closeDetailModal')?.addEventListener('click', () => {
            ui.closeModal('deviceDetailModal');
        });
        document.getElementById('editDeviceBtn')?.addEventListener('click', () => {
            ui.editCurrentDevice();
        });
        document.getElementById('deleteDeviceBtn')?.addEventListener('click', () => {
            if (state.selectedDevice) {
                deviceManager.deleteDevice(state.selectedDevice.deviceId);
                ui.closeModal('deviceDetailModal');
            }
        });

        // Settings form
        document.getElementById('settingsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            settingsManager.saveSettings();
        });

        // Export button
        document.getElementById('exportDataBtn')?.addEventListener('click', () => {
            utils.exportToExcel();
        });

        // Refresh data
        document.getElementById('refreshData')?.addEventListener('click', () => {
            ui.updateDashboard();
            ui.updateDevicesTable();
            mapManager.updateMarkers();
            utils.showToast('Data refreshed', 'success');
        });

        // Menu toggle
        document.getElementById('menuToggle')?.addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('active');
        });

        // Notification bell
        document.querySelector('.notification')?.addEventListener('click', () => {
            notificationManager.showPanel();
        });

        // Analytics device selector
        document.getElementById('analyticsDevice')?.addEventListener('change', (e) => {
            const deviceId = e.target.value;
            if (deviceId) {
                const device = state.devices.find(d => d.deviceId === deviceId);
                if (device) {
                    chartManager.updateCharts(device);
                }
            }
        });

        // Load settings
        settingsManager.loadSettings();
    },

    // Navigate to page
    navigateTo: (page) => {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

        document.getElementById(`${page}-page`)?.classList.add('active');
        document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

        if (page === 'map') {
            setTimeout(() => mapManager.initMainMap(), 100);
        }

        if (page === 'analytics') {
            ui.populateAnalyticsDeviceSelector();
            setTimeout(() => chartManager.initCharts(), 100);
        }

        ui.updateDashboard();
        ui.updateDevicesTable();
    },

    // Open add device modal
    openAddDeviceModal: () => {
        // Reset form
        document.getElementById('addDeviceForm').reset();
        
        // Set default location
        state.selectedLocation = {
            lat: CONFIG.map.defaultCenter[0],
            lng: CONFIG.map.defaultCenter[1]
        };

        // Update modal title
        document.querySelector('#addDeviceModal .modal-header h2').textContent = 
            state.editingDevice ? 'Edit Device' : 'Add New Device';

        // If editing, fill form
        if (state.editingDevice) {
            const device = state.editingDevice;
            document.getElementById('deviceId').value = device.deviceId;
            document.getElementById('deviceId').disabled = true; // Cannot change device ID
            document.getElementById('deviceName').value = device.deviceName;
            document.getElementById('sensorType').value = device.sensorType;
            document.getElementById('updateInterval').value = device.interval;
            document.getElementById('locationName').value = device.locationName;
            document.getElementById('wifiSsid').value = device.wifi;
            document.getElementById('wifiPassword').value = device.wifiPassword || '';
            document.getElementById('protocol').value = device.protocol;
            document.getElementById('serverUrl').value = device.serverUrl;
            document.getElementById('serverPort').value = device.serverPort;
            document.getElementById('mqttTopic').value = device.mqttTopic;
            
            state.selectedLocation = {
                lat: device.location.lat,
                lng: device.location.lng
            };
        } else {
            document.getElementById('deviceId').disabled = false;
        }

        ui.showModal('addDeviceModal');
        mapManager.initPickerMap();
    },

    // Edit current device from detail modal
    editCurrentDevice: () => {
        state.editingDevice = state.selectedDevice;
        ui.closeModal('deviceDetailModal');
        ui.openAddDeviceModal();
    },

    // Show modal
    showModal: (modalId) => {
        document.getElementById(modalId)?.classList.add('active');
    },

    // Close modal
    closeModal: (modalId) => {
        document.getElementById(modalId)?.classList.remove('active');
    },

    // Update dashboard
    updateDashboard: () => {
        // Update statistics
        document.getElementById('totalDevices').textContent = state.devices.length;
        
        const activeCount = state.devices.filter(d => {
            const status = utils.getDeviceStatus(d.lastUpdate);
            return status.text === 'Online';
        }).length;
        document.getElementById('activeDevices').textContent = activeCount;
        
        document.getElementById('alertsCount').textContent = state.alerts.length;
        
        // Calculate average AQI
        const devices = state.devices.filter(d => d.lastData?.aqi);
        const avgAqi = devices.length > 0
            ? devices.reduce((sum, d) => sum + d.lastData.aqi, 0) / devices.length
            : 0;
        document.getElementById('avgAqi').textContent = avgAqi > 0 ? avgAqi.toFixed(1) : '--';

        // Update recent devices
        ui.updateRecentDevices();
    },

    // Update recent devices
    updateRecentDevices: () => {
        const container = document.getElementById('recentDevices');
        if (!container) return;

        if (state.devices.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 3rem; color: var(--text-light);">
                    <i class="fas fa-inbox" style="font-size: 3rem; margin-bottom: 1rem;"></i>
                    <p>Belum ada device. Klik tombol "Add Device" untuk menambahkan.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = state.devices.slice(0, 6).map(device => {
            const aqi = device.lastData?.aqi || 0;
            const temp = device.lastData?.temp || '--';
            const humidity = device.lastData?.humidity || '--';
            const status = utils.getDeviceStatus(device.lastUpdate);
            const aqiStatus = utils.getAqiStatus(aqi);

            return `
                <div class="device-card" onclick="ui.showDeviceDetail(state.devices.find(d => d.deviceId === '${device.deviceId}'))">
                    <div class="device-card-header">
                        <div class="device-info">
                            <h3>${device.deviceName}</h3>
                            <p><i class="fas fa-map-marker-alt"></i> ${device.locationName}</p>
                        </div>
                        <span class="device-status ${status.class}">${status.text}</span>
                    </div>
                    <div class="device-readings">
                        <div class="reading">
                            <div class="reading-label">AQI</div>
                            <div class="reading-value ${aqiStatus.class}">${aqi.toFixed(1)}</div>
                        </div>
                        <div class="reading">
                            <div class="reading-label">Temp</div>
                            <div class="reading-value">${temp}°C</div>
                        </div>
                        <div class="reading">
                            <div class="reading-label">Humidity</div>
                            <div class="reading-value">${humidity}%</div>
                        </div>
                        <div class="reading">
                            <div class="reading-label">Status</div>
                            <div class="reading-value" style="font-size: 1rem;">${aqiStatus.text}</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    // Update devices table
    updateDevicesTable: () => {
        const tbody = document.getElementById('deviceTableBody');
        if (!tbody) return;

        if (state.devices.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center; padding: 3rem; color: var(--text-light);">
                        Belum ada device. Klik tombol "Add Device" untuk menambahkan.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = state.devices.map(device => {
            const status = utils.getDeviceStatus(device.lastUpdate);
            const aqi = device.lastData?.aqi || 0;
            const aqiStatus = utils.getAqiStatus(aqi);

            return `
                <tr>
                    <td><strong>${device.deviceName}</strong></td>
                    <td>${device.locationName}</td>
                    <td><span class="device-status ${status.class}">${status.text}</span></td>
                    <td><span class="${aqiStatus.class}">${aqi.toFixed(1)}</span></td>
                    <td>${device.lastData?.temp || '--'}°C</td>
                    <td>${device.lastData?.humidity || '--'}%</td>
                    <td>${utils.formatDate(device.lastUpdate)}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="action-btn action-btn-view" onclick="ui.showDeviceDetail(state.devices.find(d => d.deviceId === '${device.deviceId}'))" title="View Details">
                                <i class="fas fa-eye"></i>
                            </button>
                            <button class="action-btn action-btn-edit" onclick="ui.editDevice('${device.deviceId}')" title="Edit">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="action-btn action-btn-delete" onclick="deviceManager.deleteDevice('${device.deviceId}')" title="Delete">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    },

    // Edit device from table
    editDevice: (deviceId) => {
        const device = state.devices.find(d => d.deviceId === deviceId);
        if (device) {
            state.editingDevice = device;
            ui.openAddDeviceModal();
        }
    },

    // Show device detail modal
    showDeviceDetail: (device) => {
        if (!device) return;

        state.selectedDevice = device;

        // Update modal content
        document.getElementById('detailDeviceName').textContent = device.deviceName;
        document.getElementById('detailAqi').textContent = (device.lastData?.aqi || 0).toFixed(1);
        document.getElementById('detailTemp').textContent = `${device.lastData?.temp || '--'}°C`;
        document.getElementById('detailHum').textContent = `${device.lastData?.humidity || '--'}%`;
        document.getElementById('detailMq135').textContent = `${device.lastData?.ppm_MQ135 || '--'} ppm`;
        document.getElementById('detailMq7').textContent = `${device.lastData?.ppm_MQ7 || '--'} ppm`;
        document.getElementById('detailMq9').textContent = `${device.lastData?.ppm_MQ9 || '--'} ppm`;
        
        document.getElementById('detailDeviceId').textContent = device.deviceId;
        document.getElementById('detailLocation').textContent = device.locationName;
        
        const status = utils.getDeviceStatus(device.lastUpdate);
        document.getElementById('detailStatus').innerHTML = `<span class="device-status ${status.class}">${status.text}</span>`;
        document.getElementById('detailProtocol').textContent = device.protocol;
        document.getElementById('detailLastUpdate').textContent = utils.formatDate(device.lastUpdate);
        document.getElementById('detailUptime').textContent = utils.formatUptime(device.lastData?.uptime);

        ui.showModal('deviceDetailModal');
    },

    // Update alerts count
    updateAlertsCount: () => {
        const badge = document.querySelector('.notification .badge');
        if (badge) {
            badge.textContent = state.alerts.length;
        }
    },

    // Populate analytics device selector
    populateAnalyticsDeviceSelector: () => {
        const select = document.getElementById('analyticsDevice');
        if (!select) return;

        select.innerHTML = '<option value="">Select Device</option>' +
            state.devices.map(device => `
                <option value="${device.deviceId}">${device.deviceName}</option>
            `).join('');
    }
};

// ==================== DEVICE MANAGEMENT ====================
const deviceManager = {
    // Add new device
    addDevice: () => {
        const device = {
            deviceId: document.getElementById('deviceId').value,
            deviceName: document.getElementById('deviceName').value,
            sensorType: document.getElementById('sensorType').value,
            interval: parseInt(document.getElementById('updateInterval').value),
            locationName: document.getElementById('locationName').value,
            location: {
                lat: state.selectedLocation.lat,
                lng: state.selectedLocation.lng
            },
            wifi: document.getElementById('wifiSsid').value,
            wifiPassword: document.getElementById('wifiPassword').value,
            protocol: document.getElementById('protocol').value,
            serverUrl: document.getElementById('serverUrl').value,
            serverPort: parseInt(document.getElementById('serverPort').value),
            mqttTopic: document.getElementById('mqttTopic').value || `sensors/${document.getElementById('deviceName').value}`,
            timestamp: Date.now(),
            lastUpdate: null,
            lastData: null
        };

        // Validate
        if (!device.deviceId || !device.deviceName || !device.locationName) {
            utils.showToast('Mohon isi semua field yang wajib diisi', 'error');
            return;
        }

        // Check duplicate
        if (state.devices.find(d => d.deviceId === device.deviceId)) {
            utils.showToast('Device ID sudah ada', 'error');
            return;
        }

        // Add device
        state.devices.push(device);
        storage.saveDevices();

        // Subscribe to MQTT topic
        if (state.mqttClient && device.mqttTopic) {
            state.mqttClient.subscribe(device.mqttTopic);
            console.log('Subscribed to:', device.mqttTopic);
        }

        // Update UI
        ui.updateDashboard();
        ui.updateDevicesTable();
        ui.populateAnalyticsDeviceSelector();
        mapManager.updateMarkers();
        ui.closeModal('addDeviceModal');

        utils.showToast('Device berhasil ditambahkan!', 'success');
    },

    // Update existing device
    updateDevice: () => {
        const deviceId = document.getElementById('deviceId').value;
        const deviceIndex = state.devices.findIndex(d => d.deviceId === deviceId);
        
        if (deviceIndex === -1) {
            utils.showToast('Device tidak ditemukan', 'error');
            return;
        }

        const oldDevice = state.devices[deviceIndex];

        // Update device data
        state.devices[deviceIndex] = {
            ...oldDevice,
            deviceName: document.getElementById('deviceName').value,
            sensorType: document.getElementById('sensorType').value,
            interval: parseInt(document.getElementById('updateInterval').value),
            locationName: document.getElementById('locationName').value,
            location: {
                lat: state.selectedLocation.lat,
                lng: state.selectedLocation.lng
            },
            wifi: document.getElementById('wifiSsid').value,
            wifiPassword: document.getElementById('wifiPassword').value,
            protocol: document.getElementById('protocol').value,
            serverUrl: document.getElementById('serverUrl').value,
            serverPort: parseInt(document.getElementById('serverPort').value),
            mqttTopic: document.getElementById('mqttTopic').value
        };

        // Save to storage
        storage.saveDevices();

        // Resubscribe to MQTT if topic changed
        if (oldDevice.mqttTopic !== state.devices[deviceIndex].mqttTopic && state.mqttClient) {
            state.mqttClient.unsubscribe(oldDevice.mqttTopic);
            state.mqttClient.subscribe(state.devices[deviceIndex].mqttTopic);
        }

        // Update UI
        ui.updateDashboard();
        ui.updateDevicesTable();
        ui.populateAnalyticsDeviceSelector();
        mapManager.updateMarkers();
        ui.closeModal('addDeviceModal');
        
        state.editingDevice = null;

        utils.showToast('Device berhasil diupdate!', 'success');
    },

    // Delete device
    deleteDevice: (deviceId) => {
        if (!confirm('Apakah Anda yakin ingin menghapus device ini?')) return;

        const device = state.devices.find(d => d.deviceId === deviceId);
        
        // Unsubscribe from MQTT
        if (device && device.mqttTopic && state.mqttClient) {
            state.mqttClient.unsubscribe(device.mqttTopic);
        }

        state.devices = state.devices.filter(d => d.deviceId !== deviceId);
        storage.saveDevices();

        ui.updateDashboard();
        ui.updateDevicesTable();
        ui.populateAnalyticsDeviceSelector();
        mapManager.updateMarkers();

        utils.showToast('Device berhasil dihapus', 'success');
    },

    // Generate NFC config
    generateNfcConfig: () => {
        const config = {
            nfcId: document.getElementById('deviceId').value,
            deviceName: document.getElementById('deviceName').value,
            wifi: document.getElementById('wifiSsid').value,
            wifiPassword: document.getElementById('wifiPassword').value,
            serverUrl: document.getElementById('serverUrl').value,
            serverPort: parseInt(document.getElementById('serverPort').value),
            sensorType: document.getElementById('sensorType').value,
            interval: parseInt(document.getElementById('updateInterval').value),
            protocol: document.getElementById('protocol').value,
            mqttTopic: document.getElementById('mqttTopic').value,
            version: "1.0",
            timestamp: new Date().toISOString()
        };

        const json = JSON.stringify(config, null, 2);
        document.getElementById('nfcConfigJson').value = json;
        ui.showModal('nfcConfigModal');
    },

    // Download NFC config
    downloadNfcConfig: () => {
        const json = document.getElementById('nfcConfigJson').value;
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nfc-config-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        utils.showToast('Config berhasil didownload', 'success');
    }
};

// ==================== SETTINGS MANAGEMENT ====================
const settingsManager = {
    // Load settings into form
    loadSettings: () => {
        const settings = storage.loadSettings();
        
        // Populate form fields
        document.getElementById('aqiWarning').value = settings.aqi.warning;
        document.getElementById('aqiDanger').value = settings.aqi.danger;
        document.getElementById('tempWarning').value = settings.temp.warning;
        document.getElementById('tempDanger').value = settings.temp.danger;
        document.getElementById('humidityWarning').value = settings.humidity.warning;
        document.getElementById('humidityDanger').value = settings.humidity.danger;
        document.getElementById('mq135Warning').value = settings.mq135.warning;
        document.getElementById('mq135Danger').value = settings.mq135.danger;
        document.getElementById('mq7Warning').value = settings.mq7.warning;
        document.getElementById('mq7Danger').value = settings.mq7.danger;
        document.getElementById('mq9Warning').value = settings.mq9.warning;
        document.getElementById('mq9Danger').value = settings.mq9.danger;
    },

    // Save settings from form
    saveSettings: () => {
        const settings = {
            aqi: {
                warning: parseInt(document.getElementById('aqiWarning').value),
                danger: parseInt(document.getElementById('aqiDanger').value)
            },
            temp: {
                warning: parseInt(document.getElementById('tempWarning').value),
                danger: parseInt(document.getElementById('tempDanger').value)
            },
            humidity: {
                warning: parseInt(document.getElementById('humidityWarning').value),
                danger: parseInt(document.getElementById('humidityDanger').value)
            },
            mq135: {
                warning: parseInt(document.getElementById('mq135Warning').value),
                danger: parseInt(document.getElementById('mq135Danger').value)
            },
            mq7: {
                warning: parseInt(document.getElementById('mq7Warning').value),
                danger: parseInt(document.getElementById('mq7Danger').value)
            },
            mq9: {
                warning: parseInt(document.getElementById('mq9Warning').value),
                danger: parseInt(document.getElementById('mq9Danger').value)
            }
        };

        // Validate
        const isValid = Object.values(settings).every(sensor => 
            sensor.warning < sensor.danger
        );

        if (!isValid) {
            utils.showToast('Warning threshold harus lebih kecil dari danger threshold', 'error');
            return;
        }

        // Save to storage
        storage.saveSettings(settings);
        state.thresholds = settings;

        utils.showToast('Settings berhasil disimpan!', 'success');
    }
};

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing Air Quality Monitoring System...');

    // Load data from localStorage
    storage.loadDevices();
    storage.loadSettings();
    storage.loadSensorData();

    // Initialize UI
    ui.init();

    // Connect to MQTT
    mqttManager.connect();

    // Navigate to dashboard
    ui.navigateTo('dashboard');

    console.log('System initialized with', state.devices.length, 'devices');
});

// Make functions globally accessible for onclick handlers
window.ui = ui;
window.deviceManager = deviceManager;
window.alertManager = alertManager;
window.notificationManager = notificationManager;
window.chartManager = chartManager;
window.state = state;
window.utils = utils;
