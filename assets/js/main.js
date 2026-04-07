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

    // --- 3D SMART ROOM SIMULATION ---
    const initSimulation = () => {
        const container = document.getElementById('sim-canvas');
        if (!container) return;

        const RW=10, RH=5.6, RD=8;
        const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.shadowMap.enabled = true;
        renderer.setClearColor(0x0a1118, 1);
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
        
        const orbit = { target: new THREE.Vector3(0, 1.6, 0), yaw: 0.8, pitch: 0.38, radius: 15, yawV: 0, pitchV: 0, zoomV: 0 };
        const mat = (col, rough=0.7, metal=0.1) => new THREE.MeshStandardMaterial({ color: col, roughness: rough, metalness: metal });

        // Lights
        scene.add(new THREE.HemisphereLight(0xb0c8e0, 0x202830, 0.6));
        const sun = new THREE.DirectionalLight(0xd8e8f8, 0.8);
        sun.position.set(5, 10, 5); sun.castShadow = true;
        scene.add(sun);

        // Room
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(RW, RD), mat(0x1a2026, 0.9, 0.05));
        floor.rotation.x = -Math.PI/2; floor.receiveShadow = true; scene.add(floor);
        scene.add(new THREE.GridHelper(10, 20, 0x00d2ff, 0x051a24));

        const wallMat = new THREE.MeshStandardMaterial({ color: 0x161e26, side: THREE.DoubleSide });
        const backWall = new THREE.Mesh(new THREE.PlaneGeometry(RW, RH), wallMat);
        backWall.position.set(0, RH/2, -RD/2); scene.add(backWall);
        const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(RD, RH), wallMat);
        leftWall.position.set(-RW/2, RH/2, 0); leftWall.rotation.y = Math.PI/2; scene.add(leftWall);

        // Simple Door
        const doorGroup = new THREE.Group();
        const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.3, 0.05), mat(0x2c3e50));
        doorLeaf.position.set(0.55, 1.15, 0);
        const pivot = new THREE.Group();
        pivot.position.set(-RW/2 + 0.1, 0, 1);
        pivot.add(doorLeaf);
        scene.add(pivot);

        // Simple Fan
        const fanGroup = new THREE.Group();
        const fanBase = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05), mat(0x34495e));
        fanGroup.add(fanBase);
        const blades = new THREE.Group();
        for(let i=0; i<3; i++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.02, 0.15), mat(0x2c3e50));
            blade.position.x = 0.45; blade.rotation.y = (i * Math.PI * 2) / 3;
            blades.add(blade);
        }
        blades.position.y = 0.05; fanGroup.add(blades);
        fanGroup.position.set(0, RH - 0.1, 0); scene.add(fanGroup);

        const animate = () => {
            requestAnimationFrame(animate);
            blades.rotation.y += 0.1;
            
            // Orbit logic
            orbit.zoomV *= 0.9; orbit.yawV *= 0.9; orbit.pitchV *= 0.9;
            orbit.radius = Math.max(5, Math.min(30, orbit.radius + orbit.zoomV));
            orbit.yaw += orbit.yawV;
            orbit.pitch = Math.max(0.1, Math.min(1.4, orbit.pitch + orbit.pitchV));
            
            const cp = Math.cos(orbit.pitch);
            camera.position.set(
                orbit.target.x + orbit.radius * cp * Math.sin(orbit.yaw),
                orbit.target.y + orbit.radius * Math.sin(orbit.pitch),
                orbit.target.z + orbit.radius * cp * Math.cos(orbit.yaw)
            );
            camera.lookAt(orbit.target);
            renderer.render(scene, camera);
        };
        animate();

        // Basic Controls
        let isDragging = false, px, py;
        container.addEventListener('mousedown', e => { isDragging = true; px = e.clientX; py = e.clientY; });
        window.addEventListener('mousemove', e => {
            if (!isDragging) return;
            orbit.yawV -= (e.clientX - px) * 0.005;
            orbit.pitchV += (e.clientY - py) * 0.005;
            px = e.clientX; py = e.clientY;
        });
        window.addEventListener('mouseup', () => isDragging = false);
        container.addEventListener('wheel', e => { orbit.zoomV += e.deltaY * 0.01; e.preventDefault(); }, {passive:false});

        window.addEventListener('resize', () => {
            renderer.setSize(container.clientWidth, container.clientHeight);
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
        });
    };
    initSimulation();

    // --- CRUD LOGIC ---
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
