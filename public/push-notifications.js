// Firebase Configuration - REPLACE WITH YOUR OWN FROM FIREBASE CONSOLE
// Go to Project Settings > General > Your Apps > Web App
const firebaseConfig = {
  apiKey: "AIzaSyBPba1hz9Qr0J-Jt8oe6o6cxEZ4ZGwUQIg",
  authDomain: "olivia-ai-7e3f5.firebaseapp.com",
  projectId: "olivia-ai-7e3f5",
  storageBucket: "olivia-ai-7e3f5.firebasestorage.app",
  messagingSenderId: "900325627518",
  appId: "1:900325627518:web:58cd38fda554c9d7402a2f",
  measurementId: "G-BNM241M880"
};

// VAPID Key from Firebase Console > Project Settings > Cloud Messaging > Web Push certificates
const VAPID_KEY = "BIzXkE3Ej2WX86ttki_rpNvQwCyk7cKsw0fvoIxL7NzU2P_RGaLZFkLhfX2AZ8CPgG8zsrXooH-RjI_Czp7TbjY";

// Initialize Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('Service Worker registered with scope:', registration.scope);
      })
      .catch(error => {
        console.error('Service Worker registration failed:', error);
      });
  });
}

/**
 * Professional Notification UI Prompt
 */
function showNotificationPrompt() {
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') {
    console.warn('Notifications blocked by user');
    return;
  }

  // Create the UI elements
  const overlay = document.createElement('div');
  overlay.id = 'notificationOverlay';
  overlay.style = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    backdrop-filter: blur(8px); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
    padding: 20px; transition: opacity 0.3s ease;
  `;

  const card = document.createElement('div');
  card.style = `
    background: #121214; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 28px; padding: 32px; width: 100%; max-width: 400px;
    text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    animation: slideUp 0.5s cubic-bezier(0.165, 0.84, 0.44, 1);
  `;

  card.innerHTML = `
    <div style="width: 80px; height: 80px; background: rgba(255,77,77,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;">
      <i class="fas fa-bell" style="font-size: 2rem; color: #ff4d4d;"></i>
    </div>
    <h2 style="font-size: 1.5rem; margin-bottom: 12px; color: #fff;">Stay Updated</h2>
    <p style="color: #94a3b8; font-size: 0.95rem; margin-bottom: 32px; line-height: 1.6;">
      Enable push notifications to receive real-time alerts from Olivia even when the app is closed.
    </p>
    <div style="display: flex; gap: 12px;">
      <button id="notifCancel" style="flex: 1; padding: 14px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #94a3b8; cursor: pointer; font-weight: 600;">Maybe Later</button>
      <button id="notifEnable" style="flex: 1; padding: 14px; border-radius: 14px; border: none; background: #ff4d4d; color: #fff; cursor: pointer; font-weight: 700; box-shadow: 0 4px 15px rgba(255,77,77,0.3);">Enable Now</button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Event Listeners
  document.getElementById('notifCancel').onclick = () => {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 300);
  };

  document.getElementById('notifEnable').onclick = async () => {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      console.log('Notification permission granted.');
      setupFCM();
    }
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 300);
  };
}

/**
 * Setup Firebase Cloud Messaging
 */
async function setupFCM() {
  try {
    // Dynamically load Firebase SDKs if not already present
    if (typeof firebase === 'undefined') {
      await loadScript('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/9.22.0/firebase-analytics-compat.js');
    }

    firebase.initializeApp(firebaseConfig);
    firebase.analytics();
    const messaging = firebase.messaging();

    // Get Token
    const registration = await navigator.serviceWorker.ready;
    let currentToken;
    try {
      currentToken = await messaging.getToken({ 
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: registration 
      });
    } catch (tokenError) {
      console.error('Failed to get FCM token. Please ensure VAPID_KEY is correctly set.', tokenError);
      return;
    }

    if (currentToken) {
      console.log('FCM Token:', currentToken);
      // TODO: Send this token to your server to save it for the user
      saveTokenToServer(currentToken);
    } else {
      console.warn('No registration token available. Request permission to generate one.');
    }

    // Handle foreground messages
    messaging.onMessage((payload) => {
      console.log('Message received. ', payload);
      const notificationTitle = payload.notification.title;
      const notificationOptions = {
        body: payload.notification.body,
        icon: '/olivia.png'
      };
      new Notification(notificationTitle, notificationOptions);
    });

  } catch (error) {
    console.error('An error occurred while setting up FCM:', error);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

const PUSH_API_BASE = 'https://whatsapp-ai-bot-3-gin3.onrender.com';

function saveTokenToServer(token) {
  fetch(`${PUSH_API_BASE}/api/save-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token })
  }).then(res => {
     console.log('Token saved to Render backend');
     // Alert the user if this was a manual test
     if (window.isManualTest) {
        alert('✅ Notifications Enabled! Token registered on server.');
        window.isManualTest = false;
     }
  })
    .catch(err => console.error('Failed to save token to Render:', err));
}

async function sendTestPush() {
  const password = localStorage.getItem('olivia_pass');
  if (!password) return alert('Please login first');
  
  window.isManualTest = true;
  await setupFCM(); // Ensure we have a token

  fetch(`${PUSH_API_BASE}/api/assistant/test-push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: password })
  }).then(res => res.json())
    .then(data => {
      if (data.success) alert('📡 Test Alert Sent! Check your phone.');
      else alert('❌ Failed: ' + data.error);
    });
}

// Trigger prompt after login or after a short delay
window.addEventListener('load', () => {
  if (Notification.permission === 'granted') {
    // Already granted, initialize FCM immediately
    setupFCM();
  } else {
    // Show prompt almost immediately
    setTimeout(showNotificationPrompt, 1000);
  }
});
