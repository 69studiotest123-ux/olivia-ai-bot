
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js?v=8.11')
                    .then(reg => console.log('SW Registered', reg))
                    .catch(err => console.log('SW Error', err));
            });
        }
    