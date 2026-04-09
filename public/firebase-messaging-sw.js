importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBPba1hz9Qr0J-Jt8oe6o6cxEZ4ZGwUQIg",
  authDomain: "olivia-ai-7e3f5.firebaseapp.com",
  projectId: "olivia-ai-7e3f5",
  storageBucket: "olivia-ai-7e3f5.firebasestorage.app",
  messagingSenderId: "900325627518",
  appId: "1:900325627518:web:58cd38fda554c9d7402a2f",
  measurementId: "G-BNM241M880"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/olivia.png'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
