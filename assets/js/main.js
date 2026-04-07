document.addEventListener('DOMContentLoaded', () => {
    // --- NAVIGATION & SCROLL ---
    const links = document.querySelectorAll('.nav-links a');
    const sections = document.querySelectorAll('header, section');
    const navbar = document.querySelector('.navbar');

    links.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = link.getAttribute('href');
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                const navHeight = navbar.offsetHeight;
                window.scrollTo({
                    top: targetElement.offsetTop - navHeight - 20,
                    behavior: 'smooth'
                });
            }
        });
    });

    window.addEventListener('scroll', () => {
        let current = '';
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            if (pageYOffset >= sectionTop - navbar.offsetHeight - 100) {
                current = section.getAttribute('id');
            }
        });
        links.forEach(item => {
            item.classList.remove('active');
            if (item.getAttribute('href').includes(current)) {
                item.classList.add('active');
            }
        });
    });

    // --- 3D SMART ROOM SIMULATION (EXTRACTED FROM TESTING) ---
    const initSimulation = () => {
        const container = document.getElementById('sim-canvas');
        if (!container) return;

        const RW=10, RH=5.6, RD=8;
        const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.setClearColor(0x0a1118, 1);
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(48, container.clientWidth / container.clientHeight, 0.1, 250);
        const raycaster = new THREE.Raycaster();
        const ptr = new THREE.Vector2();
        const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const dragPt = new THREE.Vector3();

        const orbit = { target: new THREE.Vector3(0, 1.6, 0), yaw: 0.8, pitch: 0.38, radius: 13, yawV: 0, pitchV: 0, zoomV: 0 };
        const mat = (col, rough=0.78, metal=0.08) => new THREE.MeshStandardMaterial({ color: col, roughness: rough, metalness: metal });
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Lights
        scene.add(new THREE.HemisphereLight(0xb0c8e0, 0x202830, 0.52));
        const sun = new THREE.DirectionalLight(0xd8e8f8, 0.7);
        sun.position.set(4, 9, 5); sun.castShadow = true;
        sun.shadow.mapSize.set(512, 512); scene.add(sun);

        // Room
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(RW, RD), mat(0x23282e, 0.96, 0.01));
        floor.rotation.x = -Math.PI/2; floor.receiveShadow = true; scene.add(floor);
        scene.add(new THREE.GridHelper(10, 20, 0x2a313a, 0x222830));

        const wallMat = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.97, side: THREE.DoubleSide });
        const backWall = new THREE.Mesh(new THREE.PlaneGeometry(RW, RH), wallMat);
        backWall.position.set(0, RH/2, -RD/2); scene.add(backWall);
        const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(RD, RH), wallMat);
        leftWall.position.set(-RW/2, RH/2, 0); leftWall.rotation.y = Math.PI/2; scene.add(leftWall);

        // Furniture
        const box = (w,h,d,col,x,y,z,ry=0) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat(col));
            m.position.set(x,y,z); m.rotation.y = ry; m.castShadow = m.receiveShadow = true;
            scene.add(m); return m;
        };
        box(3.8, 0.04, 1.1, 0x4a3c2c, -0.3, 0.78, 2.6); // Desk
        box(2.54, 1.48, 0.065, 0x1a2030, 0, 1.7, -3.93); // TV

        // Device Management
        let devices = [];
        const deviceList = document.getElementById('deviceList');

        const labelOf = (t) => ({led:'LED 5mm',fan:'Fan DC 5V 4010',cam:'Cam Mini Indoor',esp:'ESP32 DevKit V1',door:'Smart Door'}[t]||t);

        const refreshSidebar = () => {
            if (!deviceList) return;
            deviceList.innerHTML = devices.map(d => `
                <div class="dev-card" data-id="${d.id}">
                    <div class="dev-top">
                        <div class="dev-info">
                            <div class="dev-name">${labelOf(d.type)}</div>
                            <div class="dev-id">${d.id}</div>
                            <div class="dev-status ${d.state?'on':'off'}">● ${d.state?'ON':'OFF'}</div>
                        </div>
                        <label class="sw">
                            <input type="checkbox" class="dev-toggle" data-id="${d.id}" ${d.state?'checked':''}>
                            <span class="sw-track"></span>
                        </label>
                    </div>
                    <div class="dev-controls">
                        <input type="range" min="0" max="100" value="${d.level}" class="dev-range" data-id="${d.id}">
                        <span class="dev-level">${d.level}%</span>
                        <button class="dev-del" data-id="${d.id}">✕</button>
                    </div>
                </div>
            `).join('');

            // Event Listeners
            deviceList.querySelectorAll('.dev-toggle').forEach(el => el.addEventListener('change', () => toggleDev(el.dataset.id)));
            deviceList.querySelectorAll('.dev-range').forEach(el => el.addEventListener('input', () => setLevel(el.dataset.id, el.value)));
            deviceList.querySelectorAll('.dev-del').forEach(el => el.addEventListener('click', () => removeDev(el.dataset.id)));
        };

        const buildLED = (g, refs) => {
            const dome = new THREE.Mesh(new THREE.SphereGeometry(0.036, 22, 14, 0, Math.PI*2, 0, Math.PI/2), new THREE.MeshStandardMaterial({color:0xe8f4ff, emissive:0x88ccff, emissiveIntensity:0, transparent:true, opacity:0.94}));
            dome.rotation.x = Math.PI; dome.position.y = -0.14; g.add(dome);
            const glow = new THREE.PointLight(0x8edfff, 0, 4.5, 1.6); glow.position.y = -0.16; g.add(glow);
            refs.dome = dome; refs.glow = glow;
        };

        const buildFan = (g, refs) => {
            const frame = new THREE.Mesh(new THREE.BoxGeometry(0.44,0.44,0.12), mat(0x1e2530,0.58,0.18)); g.add(frame);
            const blades = new THREE.Group(); blades.position.z = 0.045;
            for(let b=0; b<7; b++){
                const shape = new THREE.Shape(); shape.moveTo(0.008,0.044); shape.bezierCurveTo(0.045,0.048,0.125,0.082,0.158,0.142); shape.bezierCurveTo(0.125,0.138,0.062,0.1,0.022,0.058); shape.lineTo(0.008,0.044);
                const blade = new THREE.Mesh(new THREE.ShapeGeometry(shape,6), mat(0x2a3848,0.52,0.14)); blade.rotation.z = (b/7)*Math.PI*2; blades.add(blade);
            }
            blades.userData.spinRate = 0; blades.userData.targetRate = 0; g.add(blades); refs.blades = blades;
        };

        const buildCam = (g, refs) => {
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.24, 28), mat(0xd0d8e2, 0.38, 0.16)); body.rotation.x = Math.PI/2; g.add(body);
            const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 22), new THREE.MeshStandardMaterial({color:0x061018, emissive:0x0a2040, emissiveIntensity:0.2})); lens.rotation.x = Math.PI/2; lens.position.z = 0.176; g.add(lens);
            const recLed = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 8), new THREE.MeshStandardMaterial({emissive:0xff2244, emissiveIntensity:0.5})); recLed.position.set(0.03, 0.024, 0.12); g.add(recLed); refs.recLed = recLed;
        };

        const buildESP = (g, refs) => {
            const pcb = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.022, 0.28), mat(0x1e5536, 0.66, 0.05)); g.add(pcb);
            const ledStatus = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.007, 0.012), new THREE.MeshStandardMaterial({color:0xff2244*0.08, emissive:0xff2244, emissiveIntensity:0})); ledStatus.position.set(0.145, 0.017, 0.092); g.add(ledStatus); refs.ledStatus = ledStatus;
        };

        const buildDoor = (g, refs) => {
            const pivot = new THREE.Group(); pivot.position.set(-1.2/2 + 0.08, 0, 0); g.add(pivot);
            const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.08, 2.32, 0.06), mat(0x323d4d, 0.6, 0.1)); leaf.position.set(1.08/2, 2.32/2, 0); leaf.castShadow = true; pivot.add(leaf);
            const led = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 8), new THREE.MeshStandardMaterial({color:0xff0000, emissive:0xff0000, emissiveIntensity:1.5})); led.position.set(1.08-0.12, 2.32*0.45 + 0.16, 0.06/2 + 0.032); pivot.add(led);
            refs.pivot = pivot; refs.lockLed = led;
        };

        const createDevice = (type, x, z) => {
            const id = type + '-' + Math.random().toString(36).slice(2, 6);
            const group = new THREE.Group();
            const refs = {};
            let baseY = 1.2, ry = 0;

            if(type==='led') { buildLED(group, refs); baseY = RH; }
            else if(type==='fan') { buildFan(group, refs); baseY = 1.18; }
            else if(type==='cam') { buildCam(group, refs); baseY = 4.2; ry = 0.3; }
            else if(type==='door') { buildDoor(group, refs); baseY = 0; ry = Math.PI/2; }
            else { buildESP(group, refs); baseY = 1.45; x = RW/2 - 0.06; }

            group.position.set(x, baseY, z);
            group.rotation.y = ry;
            scene.add(group);
            const dev = { id, type, group, state: false, level: 75, meshRefs: refs };
            devices.push(dev);
            refreshSidebar();
            return dev;
        };

        const toggleDev = (id) => {
            const dev = devices.find(d => d.id === id); if(!dev) return;
            dev.state = !dev.state;
            const on = dev.state, lv = dev.level/100;
            if(dev.type==='led'){
                dev.meshRefs.dome.material.emissiveIntensity = on ? 0.6 + lv*3.4 : 0;
                dev.meshRefs.glow.intensity = on ? 0.4 + lv*1.8 : 0;
            } else if(dev.type==='fan'){
                dev.meshRefs.blades.userData.targetRate = on ? 8 + lv*40 : 0;
            } else if(dev.type==='cam'){
                dev.meshRefs.recLed.material.emissiveIntensity = on ? 1.8 : 0.4;
            } else if(dev.type==='door'){
                dev.meshRefs.lockLed.material.color.set(on ? 0x00ff00 : 0xff0000);
                dev.meshRefs.lockLed.material.emissive.set(on ? 0x00ff00 : 0xff0000);
            }
            refreshSidebar();
        };

        const setLevel = (id, lv) => {
            const dev = devices.find(d => d.id === id); if(!dev) return;
            dev.level = lv; refreshSidebar();
            if(dev.state) toggleDev(id); // Refresh visuals
        };

        const removeDev = (id) => {
            const idx = devices.findIndex(d => d.id === id);
            if(idx !== -1) {
                scene.remove(devices[idx].group);
                devices.splice(idx, 1);
                refreshSidebar();
            }
        };

        // UI Events
        document.querySelectorAll('.add-btn').forEach(btn => {
            btn.addEventListener('click', () => createDevice(btn.dataset.type, (Math.random()-0.5)*7, (Math.random()-0.5)*5));
        });

        // Orbit Logic
        let isDragging = false, px, py;
        container.addEventListener('mousedown', e => { isDragging = true; px = e.clientX; py = e.clientY; });
        window.addEventListener('mousemove', e => {
            if (!isDragging) return;
            orbit.yaw -= (e.clientX - px) * 0.005;
            orbit.pitch = clamp(orbit.pitch + (e.clientY - py) * 0.005, 0.1, 1.4);
            px = e.clientX; py = e.clientY;
        });
        window.addEventListener('mouseup', () => isDragging = false);
        container.addEventListener('wheel', e => { orbit.radius = clamp(orbit.radius + e.deltaY * 0.01, 5, 30); e.preventDefault(); }, {passive:false});

        const animate = () => {
            requestAnimationFrame(animate);
            const dt = 0.016;
            devices.forEach(dev => {
                if(dev.type==='fan' && dev.meshRefs.blades){
                    const bl = dev.meshRefs.blades;
                    bl.userData.spinRate += (bl.userData.targetRate - bl.userData.spinRate) * 0.1;
                    bl.rotation.z += bl.userData.spinRate * dt;
                }
                if(dev.type==='door' && dev.meshRefs.pivot){
                    const target = dev.state ? Math.PI/1.6 : 0;
                    dev.meshRefs.pivot.rotation.y += (target - dev.meshRefs.pivot.rotation.y) * 0.1;
                }
            });

            const cp = Math.cos(orbit.pitch);
            camera.position.set(orbit.target.x + orbit.radius * cp * Math.sin(orbit.yaw), orbit.target.y + orbit.radius * Math.sin(orbit.pitch), orbit.target.z + orbit.radius * cp * Math.cos(orbit.yaw));
            camera.lookAt(orbit.target);
            renderer.render(scene, camera);
        };
        animate();

        // Default Devices
        createDevice('led', 0, 0);
        createDevice('fan', -3, -2);
        createDevice('door', -RW/2+0.08, 1);

        window.addEventListener('resize', () => {
            renderer.setSize(container.clientWidth, container.clientHeight);
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
        });
    };
    initSimulation();

    // --- CRUD LOGIC FOR LOG BIMBINGAN ---
    const logTableBody = document.getElementById('logTableBody');
    const logModal = document.getElementById('logModal');
    const logForm = document.getElementById('logForm');
    const btnAddLog = document.getElementById('btnAddLog');
    const modalTitle = document.getElementById('modalTitle');
    const closeButtons = document.querySelectorAll('.close-modal');

    const defaultLogs = [
        { id: 1, date: '26-02-2026', advisor: 'Pak Hanif', consultation: '<strong>Diskusi Bentuk Alat:</strong> Miniatur vs Portable.<br><span class="tag">Keputusan:</span> Fokus ke miniatur untuk pengujian deteksi orang.', result: '<strong>Hasil:</strong> Komponen dasar (ESP, DHT, Servo) berhasil terhubung dan berjalan.' },
        { id: 2, date: '04-03-2026', advisor: 'Pak Fara', consultation: '<strong>Metode CV:</strong> TensorFlow.js (COCO-SSD).<br><span class="tag">Riset:</span> Analisis margin error saat orang berdempetan.', result: '<strong>Hasil:</strong> Sistem deteksi orang, monitoring suhu, dan kontrol alat via web sudah sinkron.' },
        { id: 3, date: '12-03-2026', advisor: 'Pak Hanif', consultation: '<strong>Implementasi AI:</strong> Penggunaan AI dalam koding.<br><span class="tag">Riset:</span> Monitoring konsumsi daya (Sensor INA219).', result: '<strong>Hasil:</strong> Pemahaman kode diperdalam, opsi monitoring daya mulai diterapkan secara opsional.' }
    ];

    let logs = JSON.parse(localStorage.getItem('ta_logs')) || defaultLogs;
    const saveLogs = () => localStorage.setItem('ta_logs', JSON.stringify(logs));

    const renderTable = () => {
        if (!logTableBody) return;
        logTableBody.innerHTML = logs.map((log, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${log.date}</td>
                <td>${log.advisor}</td>
                <td>${log.consultation}</td>
                <td>${log.result}</td>
                <td class="actions">
                    <button class="btn-icon btn-edit" data-id="${log.id}"><i class="fas fa-edit"></i></button>
                    <button class="btn-icon btn-delete" data-id="${log.id}"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', () => editLog(btn.dataset.id)));
        document.querySelectorAll('.btn-delete').forEach(btn => btn.addEventListener('click', () => deleteLog(btn.dataset.id)));
    };

    const openModal = (isEdit = false, log = null) => {
        modalTitle.textContent = isEdit ? 'Edit Log Bimbingan' : 'Tambah Log Bimbingan';
        if (isEdit && log) {
            document.getElementById('logId').value = log.id;
            document.getElementById('logDate').value = log.date;
            document.getElementById('logAdvisor').value = log.advisor;
            document.getElementById('logConsultation').value = log.consultation.replace(/<br>/g, '\n').replace(/<\/?[^>]+(>|$)/g, "");
            document.getElementById('logResult').value = log.result.replace(/<br>/g, '\n').replace(/<\/?[^>]+(>|$)/g, "");
        } else {
            logForm.reset();
            document.getElementById('logId').value = '';
        }
        logModal.classList.add('active');
    };

    const deleteLog = (id) => {
        if (confirm('Hapus log ini?')) {
            logs = logs.filter(l => l.id != id);
            saveLogs(); renderTable();
        }
    };

    const editLog = (id) => {
        const log = logs.find(l => l.id == id);
        if (log) openModal(true, log);
    };

    if (btnAddLog) btnAddLog.addEventListener('click', () => openModal(false));
    closeButtons.forEach(btn => btn.addEventListener('click', () => logModal.classList.remove('active')));

    if (logForm) logForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = document.getElementById('logId').value;
        const data = {
            id: id || Date.now(),
            date: document.getElementById('logDate').value,
            advisor: document.getElementById('logAdvisor').value,
            consultation: document.getElementById('logConsultation').value.replace(/\n/g, '<br>'),
            result: document.getElementById('logResult').value.replace(/\n/g, '<br>')
        };

        if (id) {
            const idx = logs.findIndex(l => l.id == id);
            logs[idx] = data;
        } else {
            logs.push(data);
        }

        saveLogs(); renderTable();
        logModal.classList.remove('active');
    });

    renderTable();
});
