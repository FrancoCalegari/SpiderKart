// UI Modals
function toggleModal(modalId) {
    const modal = document.getElementById(modalId);
    const overlay = document.getElementById('modal-overlay');
    
    if (modal.classList.contains('hidden')) {
        modal.classList.remove('hidden');
        overlay.classList.remove('hidden');
        document.querySelectorAll('.sw-alert').forEach(el => {
            el.textContent = '';
            el.classList.add('hidden');
        });
    } else {
        modal.classList.add('hidden');
        overlay.classList.add('hidden');
    }
}

function closeAllModals() {
    document.querySelectorAll('.sw-modal').forEach(m => m.classList.add('hidden'));
    document.getElementById('modal-overlay').classList.add('hidden');
}

// Nav Hamburger
document.getElementById('nav-toggle').addEventListener('click', function() {
    this.classList.toggle('open');
    document.getElementById('navMenu').classList.toggle('open');
});

// Scroll nav bg
window.addEventListener('scroll', () => {
    const nav = document.getElementById('sw-navbar');
    if (window.scrollY > 50) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
});

// Cargar Leaderboard
async function loadLeaderboard() {
    const listContainer = document.getElementById('leaderboard-list');
    listContainer.innerHTML = '<tr><td colspan="3"><div class="lb-spinner-wrap"><div class="sw-spinner"></div> Cargando...</div></td></tr>';
    try {
        const response = await fetch('/api/leaderboard');
        const data = await response.json();
        
        if (data.data && data.data.length > 0) {
            listContainer.innerHTML = '';
            data.data.forEach((item, index) => {
                const tr = document.createElement('tr');
                let rankHtml;
                if (index === 0) {
                    rankHtml = '<i class="fa-solid fa-trophy" style="color:#FFD700;"></i>';
                } else if (index === 1) {
                    rankHtml = '<i class="fa-solid fa-trophy" style="color:#C0C0C0;"></i>';
                } else if (index === 2) {
                    rankHtml = '<i class="fa-solid fa-trophy" style="color:#CD7F32;"></i>';
                } else {
                    rankHtml = `#${index + 1}`;
                }
                
                tr.innerHTML = `
                    <td>${rankHtml}</td>
                    <td>${item.username}</td>
                    <td style="color:var(--sw-red); font-weight:bold;">${item.score} PTS</td>
                `;
                listContainer.appendChild(tr);
            });
        } else {
            listContainer.innerHTML = '<tr><td colspan="3" style="text-align:center;">Aún no hay puntuaciones registradas.</td></tr>';
        }
    } catch (error) {
        console.error('Error cargando leaderboard:', error);
        listContainer.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--sw-red);">Error de conexión al obtener el ranking.</td></tr>';
    }
}

// Manejo de Sesión
function checkSession() {
    const username = localStorage.getItem('spiderkart_username');
    if (username) {
        document.getElementById('nav-auth-btns').classList.add('hidden');
        document.getElementById('nav-user-info').classList.remove('hidden');
        document.getElementById('logged-username').textContent = username;
    } else {
        document.getElementById('nav-auth-btns').classList.remove('hidden');
        document.getElementById('nav-user-info').classList.add('hidden');
    }
}

function logout() {
    localStorage.removeItem('spiderkart_username');
    localStorage.removeItem('spiderkart_userId');
    checkSession();
}

function showAlert(elementId, message, isSuccess = false) {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.classList.remove('hidden');
    if (isSuccess) {
        el.classList.add('sw-alert--success');
    } else {
        el.classList.remove('sw-alert--success');
    }
}

// Event Listeners para Formularios
document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    loadLeaderboard();
    
    // Configurar polling para el leaderboard (cada 2 min)
    setInterval(loadLeaderboard, 120000);

    // Registro
    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('register-username').value;
        const password = document.getElementById('register-password').value;
        
        try {
            const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await response.json();
            
            if (response.ok) {
                // Auto-login después de registro exitoso
                const loginRes = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                if (loginRes.ok) {
                    const loginData = await loginRes.json();
                    localStorage.setItem('spiderkart_username', loginData.username);
                    localStorage.setItem('spiderkart_userId', loginData.userId);
                    checkSession();
                    toggleModal('register-modal');
                    document.getElementById('register-form').reset();
                } else {
                    showAlert('register-alert', 'Registro exitoso. Inicia sesión para continuar.', true);
                    document.getElementById('register-form').reset();
                }
            } else {
                showAlert('register-alert', data.error || 'Error en el registro');
            }
        } catch (error) {
            showAlert('register-alert', 'Error de conexión con el servidor.');
        }
    });

    // Login
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        
        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await response.json();
            
            if (response.ok) {
                localStorage.setItem('spiderkart_username', data.username);
                localStorage.setItem('spiderkart_userId', data.userId);
                toggleModal('login-modal');
                document.getElementById('login-form').reset();
                checkSession();
            } else {
                showAlert('login-alert', data.error || 'Credenciales inválidas');
            }
        } catch (error) {
            showAlert('login-alert', 'Error de conexión con el servidor.');
        }
    });
});
