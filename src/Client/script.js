let currentUser = null;

const authModal = document.getElementById('authModal');
const authTitle = document.getElementById('authTitle');
const authButton = document.getElementById('authButton');
const switchAuth = document.getElementById('switchAuth');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const userList = document.getElementById('userList');

const chatContainer = document.getElementById('chatContainer');
const chatTitle = document.getElementById('chatTitle');
const closeChatBtn = document.getElementById('closeChatBtn');
const chatInput = document.getElementById('chatInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const chatMessages = document.getElementById('chatMessages');

const attachButton = document.getElementById('attachButton');
const fileInput = document.getElementById('fileInput');

const recordAudioButton = document.getElementById('recordAudioButton');
const recordVideoButton = document.getElementById('recordVideoButton');

let isLoginMode = true;
let selectedUser = null; // Поточний обраний користувач для чату

// Для запису аудіо/відео
let audioMediaRecorder, videoMediaRecorder;
let audioChunks = [];
let videoChunks = [];
let isAudioRecording = false;
let isVideoRecording = false;
let audioStream, videoStream;

// Для відстеження instant файлів
let pendingInstantFiles = {};

// Приховує список користувачів до авторизації
userList.style.display = 'none';


//Показати вікно для авторизації
function showAuthModal() {
    authModal.style.display = 'flex';
}

//Сховати вікно для авторизації
function hideAuthModal() {
    authModal.style.display = 'none';
}

// Авторизація/Реєстрація
authButton.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
        alert('Заповніть всі поля!');
        return;
    }

    if (isLoginMode) { // Авторизація
        ws.send(`login:${username}:${password}`);
    } else { // Реєстрація
        ws.send(`register:${username}:${password}`);
    }
});

//Зміна режиму авторизація/реєстрація
switchAuth.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    authTitle.textContent = isLoginMode ? 'Авторизуйтесь' : 'Реєстрація';
    authButton.textContent = isLoginMode ? 'Увійти' : 'Зареєструватися';
    switchAuth.textContent = isLoginMode ? 'Нема акаунта? Зареєструватися' : 'Уже є аккаунт? Авторизуватися';
});


// При запуску показати вікно для авторизації
window.onload = showAuthModal;

// WebSocket
const ws = new WebSocket('ws://192.168.0.105:7575');

ws.onopen = () => {
    console.log('Підключення до WebSocket встановлено');
};


// Обробка повідомлень від сервера
ws.onmessage = (event) => {
    // Лог повідомлення, отриманого від сервера
    console.log('Дані отримані:', event.data);

    // Перевірка на успішний вхід
    if (event.data.startsWith('login success')) {
        const username = usernameInput.value.trim(); // Отримання логіну з форми
        const password = passwordInput.value.trim(); // Отримання паролю з форми

        // Збереження інформації про поточного користувача
        currentUser = { username, publicID: username, password };

        hideAuthModal(); // Приховати вікно авторизації
        userList.style.display = 'block'; // Показати список користувачів видимим
        ws.send('get_users'); // Запит на список доступних користувачів
    }

    // Обробка невдалої авторизації
    else if (event.data.startsWith('login fail')) {
        alert(event.data); // Повідомлення про помилку
    }

    // Успішна реєстрація
    else if (event.data.startsWith('register success')) {
        const username = usernameInput.value.trim();
        const password = passwordInput.value.trim();

        // Збереження даних нового користувача
        currentUser = { username, publicID: username, password };

        hideAuthModal(); // Приховати вікно реєстрації
        userList.style.display = 'block'; // Показати список користувачів
        ws.send('get_users'); // Запит на оновлення списку користувачів
    }

    // Помилка під час реєстрації
    else if (event.data.startsWith('register fail')) {
        alert(event.data); // Повідомлення про помилку
    }

    // Оновлення чату для instant-повідомлення (відео/аудіо повідомлення)
    else if (event.data.startsWith('update_chat:instant')) {
        if (selectedUser && currentUser) {
            ws.send(`get_chat:${currentUser.publicID}:${selectedUser}`); // Запит на отримання історії чату
        }
    }


    // Звичайне оновлення чату
    else if (event.data === 'update_chat') {
        if (selectedUser && currentUser) {
            ws.send(`get_chat:${currentUser.publicID}:${selectedUser}`); // Запит на отримання історії чату
        }
    }


    // Історія чату
    else if (event.data.startsWith('chat_history:')) {
        const chatData = event.data.substring('chat_history:'.length).trim(); // Виділення даних історії
        updateChatWindow(chatData); // Оновлення вікна чату
    }

    // Обробка файлу
    else if (event.data.startsWith('file_data:')) {
        const parts = event.data.split(':'); // Розділення даних дані
        if (parts.length >= 3) {
            const fileName = parts[1]; // Ім'я файлу
            const base64Data = parts.slice(2).join(':'); // Дані файлу у форматі base64

            // Якщо файл є instant, відображаємо його негайно
            if (pendingInstantFiles[fileName]) {
                const senderPublicID = pendingInstantFiles[fileName]; // Отримуємо ідентифікатор відправника
                displayInstantFile(fileName, base64Data, senderPublicID); // відображення файлу
                delete pendingInstantFiles[fileName]; // Видалення запису про очікуваний instant-файл
            } else {
                // Звичайне завантаження файлу
                downloadBase64File(base64Data, fileName);
            }
        }
    }
    // Оновлення списку користувачів
    else if (currentUser) {
        updateUserList(event.data);
    }
};




ws.onerror = (error) => {
    console.error('Помилка WebSocket:', error);
};

ws.onclose = () => {
    console.log('WebSocket з`єднання закрито');
};


// Оновлення списку користувачів
function updateUserList(data) {

    // // Очищуємо HTML-контейнер для списку користувачів перед оновленням
    // userList.innerHTML = '';

    // Розбиття отриманих даних на рядки, видаляючи порожні рядки
    const users = data.split('\n').filter(line => line.trim() !== '');

    // Перебір кожного користувача з отриманого списку
    users.forEach(user => {
        // Пошуку імені користувача
        const match = user.match(/username:\s*([\w_]+)/);

        // Якщо знайдено відповідність
        if (match) {
            const publicID = match[1]; // Отримання publicID користувача
            const listItem = document.createElement('li'); // створення нового елементу списку

            // Якщо publicID співпадає з поточним користувачем, відображення "Saved messages"
            if (currentUser && publicID === currentUser.publicID) {
                listItem.textContent = 'Saved messages (me)';
            } else {
                listItem.textContent = publicID; // Для інших користувачів відображення publicID
            }

            // Обробник подій для відкриття чату з обраним користувачем
            listItem.addEventListener('click', () => {
                // Якщо поточний користувач не авторизований, попередження
                if (!currentUser) {
                    alert('Ви не авторизовані!');
                    return;
                }

                // Відкриття чату з обраним користувачем
                openChatWithUser(publicID);
            });

            // Додавання створеного елементу списку до DOM
            userList.appendChild(listItem);
        }
    });
}



// Відкриття чату
function openChatWithUser(publicID) {
    // Збереження publicID вибраного користувача
    selectedUser = publicID;

    // Оновлення заголовку чату: якщо це власний publicID,заголовок =  "Saved messages (me)"
    chatTitle.textContent = publicID === currentUser.publicID ? 'Saved messages (me)' : publicID;

    // Додавання класу "chat-open" до body, щоб панель чату стала видимою
    document.body.classList.add('chat-open');

    // Очистка поля вводу тексту для підготовки нового повідомлення
    chatInput.value = '';

    // Якщо поточний користувач авторизований і вибраний співрозмовник, запит на  історію чату
    if (currentUser && selectedUser) {
        ws.send(`get_chat:${currentUser.publicID}:${selectedUser}`);
    }
}


// Закриття чату
closeChatBtn.addEventListener('click', () => {
    // Видалення класу "chat-open" із body, щоб приховати панель чату
    document.body.classList.remove('chat-open');

    // Скидання вибраного користувача (співрозмовника), оскільки чат закритий
    selectedUser = null;

});



// Відправка текстового повідомлення
sendMessageBtn.addEventListener('click', sendMessage);



chatInput.addEventListener('keypress', (e) => {
    // Обробник події на поле вводу
    if (e.key === 'Enter') {
        // Перевіряємо, чи натиснуто клавішу "Enter".
        sendMessage();        //  Відправити повідомлення.
    }
});


function sendMessage() {
    const message = chatInput.value.trim();
    // Отримуємо введений текст із поля вводу, обрізаючи зайві пробіли з початку і кінця.
    if (!message || !selectedUser) return;
    // Перевіряємо, чи є текст у полі вводу та чи обраний користувач.
    // Якщо ні, функція завершує виконання.

    ws.send(`msg:${selectedUser}:${message}`);
    // Відправка текстового повідомлення на сервер у форматі "msg:одержувач:текст".

    addMessageToChat(currentUser.publicID, selectedUser, message, new Date().toISOString());
    // Додавання повідомлення в чат для відправника з міткою часу

    chatInput.value = '';
    // Очищастка поля вводу
}



// Обробка файлів (через "скрепку")
attachButton.addEventListener('click', () => {
    fileInput.click();
    // Клік по прихованому інпуту для вибору файлу
});

fileInput.addEventListener('change', () => {
    // Обробник події зміни вибору файлу
    if (!selectedUser || !currentUser) {
        // Перевірка, чи обраний користувач і чи авторизований поточний користувач
        alert('Оберіть користувача для відправки файлу і авторизуйтесь!');
        return;
    }

    const file = fileInput.files[0];
    // Отримання обраного файл
    if (!file) return;
    // Якщо файл не вибрано, завершити виконання функції

    const fileName = file.name;
    // Отримання назви файлу
    const fileSize = file.size;
    // Отримання розміру файлу
    const fileExt = fileName.split('.').pop();
    // Отримання розширення файлу

    const reader = new FileReader();
    // Об'єкт FileReader для читання файлу
    reader.onload = function(e) {
        // Обробник події для завершення читання файлу
        const data = e.target.result;
        // Отримання вмісту файлу
        const base64 = arrayBufferToBase64(data);
        // Конвертація вмісту файлу з ArrayBuffer у Base64-формат

        ws.send(`file:${selectedUser}:${fileName}:${fileSize}:${fileExt}:${base64}`);
        // Відправка файлу на сервер у форматі "file:одержувач:назва:розмір:розширення:вмістBase64"

        addFileMessageToChat(currentUser.publicID, selectedUser, fileName, fileSize, fileExt, new Date().toISOString());
        // Додавання повідомлення про файл у чат
    };
    reader.readAsArrayBuffer(file);
    // Читання файлу у вигляді ArrayBuffer

    fileInput.value = '';
    // Скидаємо вибір файлу, щоб можна було повторно обрати той самий файл.
});


// Запис аудіо
recordAudioButton.addEventListener('click', async () => {
    if (!currentUser || !selectedUser) {
        // Перевірка чи авторизований поточний користувач і чи вибраний співрозмовник
        alert('Оберіть користувача і авторизуйтесь для відправки аудіо!');
        return;
    }

    if (!isAudioRecording) {
        // Якщо запис не активний, запуск  запису
        isAudioRecording = true; // Прапорець, що запис активний
        recordAudioButton.classList.add('recording');
        // Додаємо клас для візуального індикатора активного запису

        try {
            // Запит на доступ до мікрофона
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            // Обробка помилки доступу до мікрофона
            console.error('Помилка доступу до мікрофону:', err);
            alert('Не вдалось отримати доступ до мікрофону.');
            isAudioRecording = false;// Видалення прапорець, якщо доступ не надано
            recordAudioButton.classList.remove('recording');// Видаляємо візуальний індикатор активного запису
            return;
        }

        // Ініціалізація об’єкта MediaRecorder для роботи з аудіо-потоком
        audioMediaRecorder = new MediaRecorder(audioStream);

        // Зберігання отриманих даних в масиві `audioChunks` під час запису
        audioMediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        // Дія після завершення запису
        audioMediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/mp3' });
            // Формування аудіо-файлу з отриманих даних
            const fileName = `audio_${Date.now()}.mp3`;
            // Генерація унікальної назву для файлу
            const fileSize = audioBlob.size;
            // Отримання розміру файлу
            const fileExt = 'mp3';
            // Встановлення розширення файлу

            const arrayBuffer = await audioBlob.arrayBuffer();
            // Перетворення Blob у ArrayBuffer для подальшої обробки
            const base64 = arrayBufferToBase64(arrayBuffer);
            // Конвертація у Base64 для передачі через WebSocket

            // Відправка файлу на сервер як "інстант" файл
            ws.send(`file_instant:${selectedUser}:${fileName}:${fileSize}:${fileExt}:${base64}`);

            // Миттєво додаємо повідомлення в чат з  аудіо-плеєром
            addInstantFileMessageToChat(currentUser.publicID, selectedUser, fileName, fileSize, fileExt, new Date().toISOString(), 'audio', base64);

            audioChunks = [];
            // Очистка масиву отриманих даних
            audioStream.getTracks().forEach(track => track.stop());
            // Зупинка всіх активних треків аудіо-потоку
        };

        audioMediaRecorder.start();
        // Запуск запису
    } else {
        // Якщо запис активний, зупиняємо його
        isAudioRecording = false;
        // Вимкнення прапореця
        recordAudioButton.classList.remove('recording');
        // Видалення класу візуального індикатора активного запису
        audioMediaRecorder.stop();
        // Зупинка запису
    }
});





// Запис відео
recordVideoButton.addEventListener('click', async () => {
    if (!currentUser || !selectedUser) {
        // Перевірка, чи користувач авторизований і чи вибраний співрозмовник
        alert('Оберіть користувача  і авторизуйтесь для відправки відео!');
        return;
    }

    if (!isVideoRecording) {
        // Якщо запис відео неактивний, запускаємо процес запису
        isVideoRecording = true; // Встановлюємо прапорець, що запис активний
        recordVideoButton.classList.add('recording');
        // Додаємо клас для візуального індикатора активного запису

        try {
            // Запитуємо доступ до камери і мікрофона
            videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (err) {
            // Обробка помилки доступу до камери чи мікрофона
            console.error('Помилка доступу до камери/мікрофону:', err);
            alert('Не вдалося отримати доступ до камери чи мікрофона.');
            isVideoRecording = false;
            // Вимкнення прапорця , якщо доступ не надано
            recordVideoButton.classList.remove('recording');
            // Видалення візуального індикатора активного запису
            return;
        }

        // Ініціалізація об’єкта MediaRecorder для запису відео
        videoMediaRecorder = new MediaRecorder(videoStream);

        // Під час запису збереження отриманих даних у масиві `videoChunks`
        videoMediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) {
                videoChunks.push(event.data);
            }
        };

        // Дія після завершення запису
        videoMediaRecorder.onstop = async () => {
            const videoBlob = new Blob(videoChunks, { type: 'video/mp4' }); // Формування відео-файлу з отриманих даних
            const fileName = `video_${Date.now()}.mp4`; // Генерація унікальної назви для файлу
            const fileSize = videoBlob.size; // Отримання розміру файлу
            const fileExt = 'mp4'; // Встановлення розширення файлу
            const arrayBuffer = await videoBlob.arrayBuffer(); // Перетворення  Blob у ArrayBuffer для подальшої обробки
            const base64 = arrayBufferToBase64(arrayBuffer); // Конвертуємо у Base64 для передачі через WebSocket

            // Відправка файлу на сервер як "інстант" файл
            ws.send(`file_instant:${selectedUser}:${fileName}:${fileSize}:${fileExt}:${base64}`);

            // Миттєве додавання повідомлення в чат з вбудованим відео-плеєром
            addInstantFileMessageToChat(currentUser.publicID, selectedUser, fileName, fileSize, fileExt, new Date().toISOString(), 'video', base64);

            videoChunks = [];// Очистка масиву отриманих даних

            videoStream.getTracks().forEach(track => track.stop());// Зупинка всіх активних треків відео-потоку

        };

        videoMediaRecorder.start();// Запуск запису відео

    } else {
        // Якщо запис активний, зупинка
        isVideoRecording = false;
        // Вимкнення прапоря
        recordVideoButton.classList.remove('recording');
        // Видалення класу візуального індикатора активного запису
        videoMediaRecorder.stop();
        // Зупинка запису відео
    }
});



// Конвертація ArrayBuffer у base64
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    // Конвертація ArrayBuffer у Uint8Array для обробки байтів
    const len = bytes.byteLength;
    // Отримуємання кількості байтів
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
        // Перетворення кожного байта у символ
    }
    return btoa(binary); // Конвертація отриманого рядка у формат Base64.

}


// Додавання звичайного повідомлення в чат
function addMessageToChat(sender, receiver, text, timestamp) {
    // Перевірка, чи є вікно чату порожнім (з плейсхолдером), якщо так - очищаємо його
    if (chatMessages.querySelector('.placeholder')) {
        chatMessages.innerHTML = '';
    }

    // Створення контейнера для нового повідомлення.
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message');

    // Формування частини з позначенням часу
    let timePart = timestamp ? `<span class="timestamp">[${new Date(timestamp).toLocaleTimeString()}]</span> ` : '';

       if (sender === currentUser.publicID) {
            // Якщо повідомлення від поточного користувача, клас для вирівнювання праворуч
            msgDiv.classList.add('right');
            msgDiv.innerHTML = `${timePart}<strong>Ви:</strong> ${text}`;
        } else {
            // Якщо повідомлення від співрозмовника, клас для вирівнювання ліворуч
            msgDiv.classList.add('left');
            msgDiv.innerHTML = `${timePart}<strong>${sender}:</strong> ${text}`;
        }

        // додавання повідомлення в чат
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

}




// Додавання повідомлення з інстантним файлом у чат
function addInstantFileMessageToChat(sender, receiver, fileName, fileSize, fileExt, timestamp, fileType, base64Data) {
    // Якщо у вікні чату є плейсхолдер, видаляємо
    if (chatMessages.querySelector('.placeholder')) {
        chatMessages.innerHTML = '';
    }

    // Створення контейнеру для нового повідомлення
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message');

    // Формування частини повідомлення з позначенням часу
    let timePart = timestamp ? `<span class="timestamp">[${new Date(timestamp).toLocaleTimeString()}]</span> ` : '';

    // Формування HTML для повідомлення, що містить посилання на завантаження та текст
    msgDiv.innerHTML = `
        ${timePart}<strong>${sender === currentUser.publicID ? 'Ви' : sender}:</strong>
        <span id="instant-${fileName}">авантаження...</span>
        <a href="#" onclick="requestFileDownload('${sender}','${fileName}')">Завантажити</a>
    `;

    // Додавання  сформованого повідомлення у вікно чату
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Відразу відображаємо вбудований плеєр для файлу
    displayInstantFile(fileName, base64Data, sender);
}

// Відображення інстантного файлу (аудіо/відео) за допомогою вбудованих плеєрів
function displayInstantFile(fileName, base64Data, senderPublicID) {
    // Визначення типу файлу за розширенням
    const fileExt = fileName.split('.').pop().toLowerCase();
    let fileType = '';
    if (fileExt === 'mp4') {
        fileType = 'video/mp4'; // Відеофайл
    } else if (fileExt === 'mp3') {
        fileType = 'audio/mp3'; // Аудіофайл
    } else {
        // Якщо тип файлу не підтримується, виведення попередження і завершення вионання
        console.warn(`Unsupported file type: ${fileExt}`);
        return;
    }

    // Конвертація base64-даних у двійковий масив
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    // Створення об'єкту Blob для відображення файлу
    const blob = new Blob([bytes], { type: fileType });
    const url = URL.createObjectURL(blob); // Генерація URL для доступу до файлу

    // Знаходження елемента `span` з id для інстантного файлу і зміна його на плеєр
    const instantSpan = document.getElementById(`instant-${fileName}`);
    if (instantSpan) {
        if (fileType.startsWith('video')) {
            // Відображення відеоплеєра
            instantSpan.innerHTML = `
                <video controls width="300">
                    <source src="${url}" type="video/mp4">
                    Ваш браузер не поддерживает тег video.
                </video>
            `;
        } else if (fileType.startsWith('audio')) {
            // Відображення аудіоплеєра
            instantSpan.innerHTML = `
                <audio controls>
                    <source src="${url}" type="audio/mp3">
                    Ваш браузер не поддерживает тег audio.
                </audio>
            `;
        }
    }
}





// Додавання повідомлення з файлом у чат
function addFileMessageToChat(sender, receiver, fileName, fileSize, fileExt, timestamp) {
    // Якщо у вікні чату є плейсхолдер, видаляємо
    if (chatMessages.querySelector('.placeholder')) {
        chatMessages.innerHTML = '';
    }

    // Створення контейнера для нового повідомлення
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message');

    // Формуєвання частини повідомлення з позначенням часу
    let timePart = timestamp ? `<span class="timestamp">[${new Date(timestamp).toLocaleTimeString()}]</span> ` : '';

    // Формування HTML для повідомлення, що містить посилання на завантаження файлу
    msgDiv.classList.add('right');
    msgDiv.innerHTML = `
        ${timePart}<img src="icons/file.png" alt="File" class="file-icon">
        <a href="#" onclick="requestFileDownload('${sender}','${fileName}')">${fileName} (${formatFileSize(fileSize)}) .${fileExt}</a>
    `;

    // Додавання повідомлення у вікно чату
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Форматування розміру файлу
function formatFileSize(bytes) {
    // Конвертуємо розмір файлу у зрозумілий формат: B, KB, MB, або GB
    if (bytes < 1024) return bytes + ' B'; // Якщо розмір менше 1 KB
    else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'; // Якщо розмір менше 1 MB
    else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; // Якщо розмір менше 1 GB
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'; // Для розмірів більше 1 GB
}

// Оновлення вікна чату з історією повідомлень
function updateChatWindow(chatData) {
    chatMessages.innerHTML = '';
    if (!chatData.trim()) {
        chatMessages.innerHTML = '<div class="placeholder">Повідомлень поки нема</div>';
        return;
    }

    const lines = chatData.split('\n').filter(line => line.trim() !== '');
    lines.forEach(line => {
        const parts = line.split('|');
        if (parts.length === 3) {
            const sender = parts[0].trim();
            const timestamp = parts[1].trim();
            const msgText = parts[2].trim();

            // Перевірка,чи починається повідомлення з  file: або file_instant:
            if (msgText.startsWith('file:')) {
                const fileParts = msgText.split(':');
                if (fileParts.length >= 4) {
                    const fileName = fileParts[1];
                    const fileSize = fileParts[2];
                    const fileExt = fileParts[3];

                    // Додавання файлу в чат
                    addFileMessageToChat(sender, selectedUser, fileName, fileSize, fileExt, timestamp);
                }
            } else if (msgText.startsWith('file_instant:')) {
                const fileParts = msgText.split(':');
                if (fileParts.length >= 6) {
                    const fileName = fileParts[2];
                    const fileSize = fileParts[3];
                    const fileExt = fileParts[4];
                    const fileBase64 = fileParts[5];

                    // Додавання інстат файлу в чат
                    addInstantFileMessageToChat(sender, selectedUser, fileName, fileSize, fileExt, timestamp, 'instant', fileBase64);
                }
            } else {
                // Звичайне текстове повідомлення
                addMessageToChat(sender, selectedUser, msgText, timestamp);
            }
        }
    });
}

// Запит на завантаження файлу
function requestFileDownload(publicID, fileName) {
    // Перевіряємо, чи авторизований користувач
    if (!currentUser) {
        alert('Ви не авторизовані!');
        return;
    }

    // Відправка запиту на сервер для отримання файлу
    ws.send(`get_file:${publicID}:${fileName}`);
}

// Завантаження файлу за даними base64
function downloadBase64File(base64Data, filename) {
    // Декодування base64 у двійкові дані.
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    // Створення Blob для завантаження файлу
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    // Створення посилання для завантаження файлу
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);

    // Клік на посилання для автоматичного завантаження файлу
    a.click();

    // Видалення створеного посилання і звільнення URL
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}




// Динамічне оновлення списку користувачів кожні 5 секунд
setInterval(() => {
    // Перевірка, чи з'єднання WebSocket відкрите (OPEN) і чи є авторизований користувач
    if (ws.readyState === WebSocket.OPEN && currentUser) {
        // Запит на сервер для отримання списку користувачів
        ws.send('get_users');
        // Очистка HTML-контейнера для списку користувачів перед оновленням
        userList.innerHTML = '';
    }
}, 5000);
