importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyBPba1hz9Qr0J-Jt8oe6o6cxEZ4ZGwUQIg",
  authDomain: "olivia-ai-7e3f5.firebaseapp.com",
  projectId: "olivia-ai-7e3f5",
  storageBucket: "olivia-ai-7e3f5.firebasestorage.app",
  messagingSenderId: "900325627518",
  appId: "1:900325627518:web:58cd38fda554c9d7402a2f",
  measurementId: "G-BNM241M880"
};

// Initialize Firebase
try {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  // Background message handler
  // NOTE: FCM automatically shows a notification when the payload contains a 'notification' field.
  // We only need this handler for custom data-only messages.
  // Registering an empty handler prevents FCM from throwing errors in background.
  messaging.onBackgroundMessage(function(payload) {
    console.log('[firebase-messaging-sw.js] Background message received:', payload);
    // FCM already auto-displays the notification from the 'notification' field.
    // No manual showNotification needed — that was causing duplicates!
  });
} catch (e) {
  console.log('Firebase background messaging initialization error:', e);
}

