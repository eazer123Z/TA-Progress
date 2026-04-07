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

    // --- CRUD LOGIC ---
    const logTableBody = document.getElementById('logTableBody');
    const logModal = document.getElementById('logModal');
    const logForm = document.getElementById('logForm');
    const btnAddLog = document.getElementById('btnAddLog');
    const modalTitle = document.getElementById('modalTitle');
    const closeButtons = document.querySelectorAll('.close-modal');

    // Initial Data
    const defaultLogs = [
        {
            id: 1,
            date: '26-02-2026',
            advisor: 'Pak Hanif',
            consultation: '<strong>Diskusi Bentuk Alat:</strong> Miniatur vs Portable.<br><span class="tag">Keputusan:</span> Fokus ke miniatur untuk pengujian deteksi orang.',
            result: '<strong>Hasil:</strong> Komponen dasar (ESP, DHT, Servo) berhasil terhubung dan berjalan.'
        },
        {
            id: 2,
            date: '04-03-2026',
            advisor: 'Pak Fara',
            consultation: '<strong>Metode CV:</strong> TensorFlow.js (COCO-SSD).<br><span class="tag">Riset:</span> Analisis margin error saat orang berdempetan.',
            result: '<strong>Hasil:</strong> Sistem deteksi orang, monitoring suhu, dan kontrol alat via web sudah sinkron.'
        },
        {
            id: 3,
            date: '12-03-2026',
            advisor: 'Pak Hanif',
            consultation: '<strong>Implementasi AI:</strong> Penggunaan AI dalam koding.<br><span class="tag">Riset:</span> Monitoring konsumsi daya (Sensor INA219).',
            result: '<strong>Hasil:</strong> Pemahaman kode diperdalam, opsi monitoring daya mulai diterapkan secara opsional.'
        }
    ];

    let logs = JSON.parse(localStorage.getItem('ta_logs')) || defaultLogs;

    function saveLogs() {
        localStorage.setItem('ta_logs', JSON.stringify(logs));
    }

    function renderTable() {
        logTableBody.innerHTML = '';
        logs.forEach((log, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${index + 1}</td>
                <td>${log.date}</td>
                <td>${log.advisor}</td>
                <td>${log.consultation}</td>
                <td>${log.result}</td>
                <td class="actions">
                    <button class="btn-icon btn-edit" data-id="${log.id}"><i class="fas fa-edit"></i></button>
                    <button class="btn-icon btn-delete" data-id="${log.id}"><i class="fas fa-trash"></i></button>
                </td>
            `;
            logTableBody.appendChild(tr);
        });

        // Add event listeners for edit/delete buttons
        document.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', () => editLog(btn.dataset.id));
        });
        document.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteLog(btn.dataset.id));
        });
    }

    function openModal(isEdit = false, log = null) {
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
    }

    function closeModal() {
        logModal.classList.remove('active');
    }

    function deleteLog(id) {
        if (confirm('Apakah Anda yakin ingin menghapus log ini?')) {
            logs = logs.filter(log => log.id != id);
            saveLogs();
            renderTable();
        }
    }

    function editLog(id) {
        const log = logs.find(l => l.id == id);
        if (log) openModal(true, log);
    }

    btnAddLog.addEventListener('click', () => openModal(false));
    closeButtons.forEach(btn => btn.addEventListener('click', closeModal));

    logForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = document.getElementById('logId').value;
        const date = document.getElementById('logDate').value;
        const advisor = document.getElementById('logAdvisor').value;
        const consultation = document.getElementById('logConsultation').value.replace(/\n/g, '<br>');
        const result = document.getElementById('logResult').value.replace(/\n/g, '<br>');

        if (id) {
            // Update
            const index = logs.findIndex(l => l.id == id);
            logs[index] = { ...logs[index], date, advisor, consultation, result };
        } else {
            // Create
            const newLog = {
                id: Date.now(),
                date,
                advisor,
                consultation,
                result
            };
            logs.push(newLog);
        }

        saveLogs();
        renderTable();
        closeModal();
    });

    // Initial render
    renderTable();
});
