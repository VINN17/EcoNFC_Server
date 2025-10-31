// ==================== CONFIGURATION ====================
const CONFIG = {
    mqtt: {
        broker: 'broker.hivemq.com',
        port: 8000, // WebSocket port
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
        settings: 'aqi_settings'
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
    }
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
    }
};

// ==================== STORAGE MANAGEMENT ====================
const storage = {
    // Save devices
    saveDevices: () => {
        localStorage.setItem(CONFIG.storage.devices, JSON.stringify(state.devices));
    },

    // Load devices
    loadDevices: () => {
        const data = localStorage.getItem(CONFIG.storage.devices);
        if (data) {
            state.devices = JSON.parse(data);
        }
    },

    // Save settings
    saveSettings: (settings) => {
        localStorage.setItem(CONFIG.storage.settings, JSON.stringify(settings));
    },

    // Load settings
    loadSettings: () => {
        const data = localStorage.getItem(CONFIG.storage.settings);
        return data ? JSON.parse(data) : null;
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
                
                // Add data point to history for charts
                chartManager.addDataPoint(device);
                
                // Update display
                storage.saveDevices();
                ui.updateDashboard();
                ui.updateDevicesTable();
                mapManager.updateMarkers();
                
                // Check for alerts
                if (data.aqi >= 100) {
                    notificationManager.addAlert(device, 'High AQI detected!');
                }
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

// ==================== MAP MANAGEMENT ====================
const mapManager = {
    pickerMarker: null,

    // Initialize main map
    initMainMap: () => {
        if (state.maps.main) {
            state.maps.main.remove();
        }

        state.maps.main = L.map('map').setView(CONFIG.map.defaultCenter, CONFIG.map.defaultZoom);
        
        L.tileLayer(CONFIG.map.tileLayer, {
            attribution: CONFIG.map.attribution
        }).addTo(state.maps.main);

        mapManager.updateMarkers();
    },

    // Initialize map picker - FIXED
    initMapPicker: () => {
        console.log('Initializing map picker...');
        
        // Remove existing map
        if (state.maps.picker) {
            state.maps.picker.remove();
            state.maps.picker = null;
        }

        // Wait for modal to be visible
        setTimeout(() => {
            const mapPickerDiv = document.getElementById('mapPicker');
            if (!mapPickerDiv) {
                console.error('Map picker div not found');
                return;
            }

            // Create new map
            state.maps.picker = L.map('mapPicker', {
                center: [state.selectedLocation.lat, state.selectedLocation.lng],
                zoom: 13,
                zoomControl: true,
                scrollWheelZoom: true
            });
            
            // Add tile layer
            L.tileLayer(CONFIG.map.tileLayer, {
                attribution: CONFIG.map.attribution,
                maxZoom: 19
            }).addTo(state.maps.picker);

            // Add draggable marker
            mapManager.pickerMarker = L.marker(
                [state.selectedLocation.lat, state.selectedLocation.lng], 
                { draggable: true }
            ).addTo(state.maps.picker);

            // Update location on marker drag
            mapManager.pickerMarker.on('dragend', function(e) {
                const pos = e.target.getLatLng();
                state.selectedLocation = { lat: pos.lat, lng: pos.lng };
                document.getElementById('selectedLat').textContent = pos.lat.toFixed(6);
                document.getElementById('selectedLng').textContent = pos.lng.toFixed(6);
                console.log('Marker dragged to:', pos);
            });

            // Update location on map click
            state.maps.picker.on('click', function(e) {
                state.selectedLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
                mapManager.pickerMarker.setLatLng(e.latlng);
                document.getElementById('selectedLat').textContent = e.latlng.lat.toFixed(6);
                document.getElementById('selectedLng').textContent = e.latlng.lng.toFixed(6);
                console.log('Map clicked at:', e.latlng);
            });

            // Force map to render properly
            setTimeout(() => {
                state.maps.picker.invalidateSize();
                console.log('Map picker initialized successfully');
            }, 200);

        }, 300);
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
            if (device.location && device.location.lat && device.location.lng) {
                const aqi = device.lastData?.aqi || 0;
                const status = utils.getAqiStatus(aqi);
                
                // Choose marker color based on AQI
                let markerColor = '#10B981'; // Green
                if (aqi >= 200) markerColor = '#7C3AED'; // Purple
                else if (aqi >= 100) markerColor = '#EF4444'; // Red
                else if (aqi >= 50) markerColor = '#F59E0B'; // Orange
                else if (aqi >= 20) markerColor = '#3B82F6'; // Blue

                const markerIcon = L.divIcon({
                    className: 'custom-marker',
                    html: `<div style="background: ${markerColor}; width: 30px; height: 30px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.2);"></div>`
                });

                const marker = L.marker([device.location.lat, device.location.lng], {
                    icon: markerIcon
                }).addTo(state.maps.main);

                // Popup content
                const popupContent = `
                    <div class="popup-content">
                        <h4>${device.deviceName}</h4>
                        <p>${device.locationName}</p>
                        <div class="popup-aqi ${status.class}">${aqi.toFixed(1)}</div>
                        <div class="popup-readings">
                            <div class="popup-reading">
                                <span>Temperature:</span>
                                <strong>${device.lastData?.temp || '--'}°C</strong>
                            </div>
                            <div class="popup-reading">
                                <span>Humidity:</span>
                                <strong>${device.lastData?.humidity || '--'}%</strong>
                            </div>
                            <div class="popup-reading">
                                <span>MQ135:</span>
                                <strong>${device.lastData?.ppm_MQ135 || '--'} ppm</strong>
                            </div>
                        </div>
                    </div>
                `;

                marker.bindPopup(popupContent);
                marker.on('click', () => {
                    ui.showDeviceDetail(device);
                });
            }
        });
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
        // In production, this should come from your database
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

// ==================== UI MANAGEMENT ====================
const ui = {
    // Initialize UI
    init: () => {
        ui.setupEventListeners();
        ui.updateDashboard();
        ui.updateDevicesTable();
    },

    // Setup event listeners
    setupEventListeners: () => {
        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const page = e.currentTarget.dataset.page;
                ui.navigateTo(page);
            });
        });

        // Menu toggle (mobile)
        document.getElementById('menuToggle')?.addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('active');
        });

        // Notification bell - FIXED
        document.querySelector('.notification')?.addEventListener('click', () => {
            notificationManager.showPanel();
        });

        // Add device buttons
        document.getElementById('addDeviceBtn')?.addEventListener('click', () => {
            ui.showAddDeviceModal();
        });
        document.getElementById('addDeviceBtn2')?.addEventListener('click', () => {
            ui.showAddDeviceModal();
        });

        // Close modals
        document.getElementById('closeModal')?.addEventListener('click', () => {
            ui.closeModal('addDeviceModal');
        });
        document.getElementById('closeDetailModal')?.addEventListener('click', () => {
            ui.closeModal('deviceDetailModal');
        });
        document.getElementById('closeNfcModal')?.addEventListener('click', () => {
            ui.closeModal('nfcConfigModal');
        });

        // Cancel add device
        document.getElementById('cancelAddDevice')?.addEventListener('click', () => {
            ui.closeModal('addDeviceModal');
        });

        // Add device form
        document.getElementById('addDeviceForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            deviceManager.addDevice();
        });

        // Generate NFC config
        document.getElementById('generateNfcBtn')?.addEventListener('click', () => {
            deviceManager.generateNfcConfig();
        });

        // Copy NFC config
        document.getElementById('copyNfcConfig')?.addEventListener('click', () => {
            const textarea = document.getElementById('nfcConfigJson');
            textarea.select();
            document.execCommand('copy');
            utils.showToast('Copied to clipboard!', 'success');
        });

        // Download NFC config
        document.getElementById('downloadNfcConfig')?.addEventListener('click', () => {
            deviceManager.downloadNfcConfig();
        });

        // Refresh data
        document.getElementById('refreshData')?.addEventListener('click', () => {
            ui.updateDashboard();
            utils.showToast('Data refreshed', 'success');
        });

        // Analytics device selector - FIXED
        document.getElementById('analyticsDevice')?.addEventListener('change', (e) => {
            const deviceId = e.target.value;
            const device = state.devices.find(d => d.deviceId === deviceId);
            if (device) {
                chartManager.updateCharts(device);
            }
        });
    },

    // Navigate to page
    navigateTo: (pageName) => {
        // Update navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-page="${pageName}"]`)?.classList.add('active');

        // Update pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.remove('active');
        });
        document.getElementById(`${pageName}-page`)?.classList.add('active');

        // Initialize page-specific features
        if (pageName === 'map') {
            setTimeout(() => {
                mapManager.initMainMap();
            }, 100);
        } else if (pageName === 'analytics') {
            chartManager.initCharts();
            ui.populateAnalyticsDeviceSelector();
        }
    },

    // Show modal
    showModal: (modalId) => {
        document.getElementById(modalId)?.classList.add('active');
    },

    // Close modal
    closeModal: (modalId) => {
        document.getElementById(modalId)?.classList.remove('active');
    },

    // Show add device modal
    showAddDeviceModal: () => {
        // Reset form
        document.getElementById('addDeviceForm')?.reset();
        
        // Set default location
        state.selectedLocation = {
            lat: CONFIG.map.defaultCenter[0],
            lng: CONFIG.map.defaultCenter[1]
        };
        document.getElementById('selectedLat').textContent = state.selectedLocation.lat.toFixed(6);
        document.getElementById('selectedLng').textContent = state.selectedLocation.lng.toFixed(6);

        ui.showModal('addDeviceModal');
        
        // Initialize map picker after modal is visible
        setTimeout(() => {
            mapManager.initMapPicker();
        }, 100);
    },

    // Update dashboard
    updateDashboard: () => {
        // Update statistics
        const totalDevices = state.devices.length;
        const activeDevices = state.devices.filter(d => {
            const status = utils.getDeviceStatus(d.lastUpdate);
            return status.class === 'status-online';
        }).length;

        const alerts = state.devices.filter(d => {
            return d.lastData?.aqi >= 100;
        }).length;

        const avgAqi = state.devices.length > 0
            ? (state.devices.reduce((sum, d) => sum + (d.lastData?.aqi || 0), 0) / state.devices.length).toFixed(1)
            : '--';

        document.getElementById('totalDevices').textContent = totalDevices;
        document.getElementById('activeDevices').textContent = activeDevices;
        document.getElementById('alertsCount').textContent = alerts;
        document.getElementById('avgAqi').textContent = avgAqi;

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
                    <p>No devices yet. Click "Add Device" to get started.</p>
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
                        No devices found
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
                            <button class="action-btn action-btn-view" onclick="ui.showDeviceDetail(state.devices.find(d => d.deviceId === '${device.deviceId}'))">
                                <i class="fas fa-eye"></i>
                            </button>
                            <button class="action-btn action-btn-delete" onclick="deviceManager.deleteDevice('${device.deviceId}')">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
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
            utils.showToast('Please fill all required fields', 'error');
            return;
        }

        // Check duplicate
        if (state.devices.find(d => d.deviceId === device.deviceId)) {
            utils.showToast('Device ID already exists', 'error');
            return;
        }

        // Add device
        state.devices.push(device);
        storage.saveDevices();

        // Subscribe to MQTT topic
        if (state.mqttClient && device.mqttTopic) {
            state.mqttClient.subscribe(device.mqttTopic);
        }

        // Update UI
        ui.updateDashboard();
        ui.updateDevicesTable();
        ui.closeModal('addDeviceModal');

        utils.showToast('Device added successfully!', 'success');
    },

    // Delete device
    deleteDevice: (deviceId) => {
        if (!confirm('Are you sure you want to delete this device?')) return;

        state.devices = state.devices.filter(d => d.deviceId !== deviceId);
        storage.saveDevices();

        ui.updateDashboard();
        ui.updateDevicesTable();
        mapManager.updateMarkers();

        utils.showToast('Device deleted', 'success');
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
        utils.showToast('Config downloaded', 'success');
    }
};

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing Air Quality Monitoring System...');

    // Load data
    storage.loadDevices();

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
window.notificationManager = notificationManager;

window.state = state;
