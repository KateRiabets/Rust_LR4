mod database;

use database::{Database, User, Message as DbMessage};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::accept_async;
use tungstenite::protocol::Message;
use tokio::sync::{ Mutex};
use futures_util::{StreamExt, SinkExt};
use std::sync::Arc;
use mongodb::bson::doc;
use chrono::Utc;
use std::collections::HashMap;  
use std::fs;
use base64::{decode, encode};

type ClientsMap = Arc<Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<Message>>>>;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Ініціалізація параметрів підключення до бази даних MongoDB
    let db_uri = "mongodb+srv://LocalChat:BQUP3nbljOEbCoHy@cluster0.9x2gr.mongodb.net/?retryWrites=true&w=majority";
    let db_name = "LocalChatDB";

    // Створення асинхронного з'єднання з базою даних
    let db = Database::new(db_uri, db_name).await?;
    println!("підключення до MongoDB встановлено");

    // Адреса і порт для WebSocket-сервер
    let addr = "0.0.0.0:7575";

    // Ствоорення TCP-сервера для прослуховування вхідних підключень
    let listener = TcpListener::bind(addr).await?;
    println!("Сервер запущений на {}", addr);


    // Ініціалізація структури для збереження активних клієнтів
    let clients: ClientsMap = Arc::new(Mutex::new(HashMap::new()));

    // Цикл для обробки нових клієнтських підключень
    loop {
        // Очікування нового підключення клієнта
        let (stream, addr) = listener.accept().await?;
        println!("Підключився клієнт: {}", addr);

        // Клонування бази даних та списку клієнтів для передачі в асинхронне завдання
        let db_clone = db.clone();
        let clients_clone = clients.clone();

        // Створення асинхронного завдання для обробки підключення
        tokio::spawn(async move {
            // Виклик функції `handle_connection`, яка обробляє підключення клієнта
            if let Err(e) = handle_connection(stream, addr, db_clone, clients_clone).await {
                eprintln!("Помилка обробки клієнта {}: {:?}", addr, e);
            }
        });
    }
}

async fn handle_connection(
    stream: TcpStream,            // TCP-з'єднання, отримане від клієнта
    addr: std::net::SocketAddr,   // IP-адреса клієнта
    db: Database,                 // Об'єкт для роботи з базою даних
    clients: ClientsMap,          // Список активних клієнтів
) -> Result<(), Box<dyn std::error::Error>> {
    // Приймаємо TCP-з'єднання і перетворюємо його на WebSocket-з'єднання
    let ws_stream = accept_async(stream).await?;
    println!("WebSocket підключення встановлено: {}", addr);

    // Створення каналу для передачі повідомлень від сервера до клієнта
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

    // Розділення WebSocket-потоку на два компоненти:
    // - ws_writer: для надсилання повідомлень клієнту
    // - ws_reader: для отримання повідомлень від клієнта
    let (mut ws_writer, mut ws_reader) = ws_stream.split();


    // Окреме асинхронне завдання для обробки надсилання повідомлень клієнту
    let write_task = tokio::spawn(async move {
        // Цикл читання повідомлень із каналу (rx)
        while let Some(msg) = rx.recv().await {
            // Якщо отримано повідомлення, спроба надіслати його клієнту
            if let Err(e) = ws_writer.send(msg).await {
                eprintln!("Помилка при відправці повідомлення: {:?}", e);
                break;
            }
        }
    });
    // Ідентифікатор поточного клієнта
    let mut current_public_id: Option<String> = None;

    // Отримання списку користувачів із бази даних
    {
        // Отримуємання курсору для всіх документів у колекції "users"
        let mut users_cursor = db.users_collection().find(None, None).await?;

        //Рядок, який зберігатиме список користувачів
        let mut user_list = String::new();

        // Ітерація через результати курсора
        while let Some(user_result) = users_cursor.next().await {
            match user_result {
                Ok(user_doc) => {
                    // Якщо успішно отримано документ, додавання інформації про користувача до списку
                    user_list.push_str(&format!(
                        "username: {}, publicID: {}\n",
                        user_doc.username, user_doc.public_id
                    ));
                }
                Err(e) => {
                    eprintln!("Помилка при читанні користувача: {:?}", e);
                }
            }
        }
        // Надсилання списку користувачів новому клієнту через WebSocket
        tx.send(Message::Text(user_list)).unwrap_or_else(|e| {
            eprintln!("Помилка надсилання списку користувачів: {:?}", e);
        });
    }

    // Цикл обробки повідомлень, які надсилає клієнт
    while let Some(Ok(Message::Text(text))) = ws_reader.next().await {
        if let Some(ref pid) = current_public_id {
            println!("Отриманння повідомлення від {} (PublicID: {}): {}", addr, pid, text);
        } else {
            println!("Отриманння повідомлення від {}: {}", addr, text);
        }

        match text.split(':').next() {
            Some("register") => {
                handle_register(&text, &mut current_public_id, &db, &tx, &clients).await?;
            }
            Some("login") => {
                handle_login(&text, &mut current_public_id, &db, &tx, &clients).await?;
            }
            Some("get_users") => {
                handle_get_users(&db, &tx).await?;
            }
            Some("msg") => {
                handle_message(&text, &current_public_id, &db, &tx, &clients).await?;
            }
            Some("file") => {
                handle_file_common(&text, &current_public_id, &db, &tx, &clients, false).await?;
            }
            Some("file_instant") => {
                handle_file_common(&text, &current_public_id, &db, &tx, &clients, true).await?;
            }
            Some("get_chat") => {
                handle_get_chat(&text, &db, &tx).await?;
            }
            Some("get_file") => {
                handle_get_file(&text, &current_public_id, &tx).await?;
            }
            _ => {
                tx.send(Message::Text(format!("Эхо: {}", text))).unwrap_or_else(|e| {
                    eprintln!("Ошибка отправки эхо-сообщения: {:?}", e);
                });
            }
        }
    }

    // Видалення клієнту з активних
    if let Some(ref pid) = current_public_id {
        let mut clients_lock = clients.lock().await;
        clients_lock.remove(pid);
    }

    println!("Соединение с клиентом {} закрыто.", addr);

    // Завершення відправки повідомлень і очистка ресурсів
    drop(tx);
    write_task.await?;

    Ok(())
}



async fn handle_register(
    text: &str,
    current_public_id: &mut Option<String>,
    db: &Database,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
    clients: &ClientsMap,
) -> Result<(), Box<dyn std::error::Error>> {
    // Розділення вхідного тексту на частини за символом ":"
    let parts: Vec<&str> = text.split(':').collect();
    // Якщр  вхідні дані містять три частини (користувач, пароль)
    if parts.len() == 3 {
        let username = parts[1].trim(); //Ім'я
        let password = parts[2].trim();// пароль

        // Перевіркаа, чи вже існує користувач
        if let Ok(Some(_existing)) = db.find_user_by_username(username).await {
            tx.send(Message::Text("register fail: user exists".to_string()))
                .unwrap_or_else(|e| {
                    eprintln!("Помилка відправки повідомлення: {:?}", e);
                });
        } else {
            // Створення нового користувача
            let new_user = User {
                username: username.to_string(),
                password: password.to_string(),
                public_id: username.to_string(),
            };
            //Додавання нового користувача
            db.add_user(new_user).await?;

            //Повідомлення про успішну реєстрацію
            tx.send(Message::Text("register success".to_string()))
                .unwrap_or_else(|e| {
                    eprintln!("Помилка відправки повідомлення: {:?}", e);
                });

            //Оновлення поточного користувача
            *current_public_id = Some(username.to_string());

            // Створення папкидля нового користувача
            let storage_path = format!("src/CloudStorage/{}", username);
            if let Err(e) = fs::create_dir_all(&storage_path) {
                eprintln!(
                    "Помилка створення папки для користувача {}: {:?}",
                    username, e
                );
            } else {
                println!(
                    "Папку для користувача {} створено: {}",
                    username, storage_path
                );
            }

            // Додавання користувача в список активних клиентів
            let mut clients_lock = clients.lock().await;
            clients_lock.insert(username.to_string(), tx.clone());
        }
    } else {
        // Неправильний формат даних
        tx.send(Message::Text("register fail: invalid format".to_string()))
            .unwrap_or_else(|e| {
                eprintln!("Ошибка отправки сообщения: {:?}", e);
            });
    }

    Ok(())
}




async fn handle_login(
    text: &str,
    current_public_id: &mut Option<String>,
    db: &Database,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
    clients: &ClientsMap,
) -> Result<(), Box<dyn std::error::Error>> {
    let parts: Vec<&str> = text.split(':').collect(); // РОзділення тексту на частини
    if parts.len() == 3 { // Перевірка формату введення
        let username = parts[1].trim(); // Отримання логіну
        let password = parts[2].trim(); // Отриманння  паролю

        //Перевірка існування користувача
        if let Ok(Some(user)) = db.find_user_by_username(username).await {
            // Перевірка пароля
            if user.password == password {
                tx.send(Message::Text("login success".to_string()))
                    .unwrap_or_else(|e| {
                        eprintln!("Помилка надсилання  повідомлення: {:?}", e);
                    });

                // Оновлення поточного користувача
                *current_public_id = Some(user.public_id.clone());

                // Додавання користувача до списку активних клієнтів
                let mut clients_lock = clients.lock().await;
                clients_lock.insert(user.public_id.clone(), tx.clone());
            } else { // Надсилання повідомлення про невірний пароль
                tx.send(Message::Text("login fail: wrong password".to_string()))
                    .unwrap_or_else(|e| {
                        eprintln!("Помилка надсилання повідомлення: {:?}", e);
                    });
            }
        } else { // Надсилання повідомлення про відсутність користувача
            tx.send(Message::Text("login fail: user not found".to_string()))
                .unwrap_or_else(|e| {
                    eprintln!("Помилка надсилання повідомлення: {:?}", e);
                });
        }
    } else {
        // Надсилання повідомлення про некоректний формат команди
        tx.send(Message::Text("login fail: invalid format".to_string()))
            .unwrap_or_else(|e| {
                eprintln!("Помилка надсилання повідомлення: {:?}", e);
            });
    }

    Ok(())
}




async fn handle_get_users(
    db: &Database,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Отримання курсора для перегляду колекції користувачів у базі даних
    // Рядок для збереження списку користувачів
    let mut users_cursor = db.users_collection().find(None, None).await?;
    let mut user_list = String::new();

    // Ітерація по курсору з результатами
    while let Some(user_result) = users_cursor.next().await {
        match user_result {
            Ok(user_doc) => {
                user_list.push_str(&format!( // Формування рядка зі списком користувачів
                                             "username: {}, publicID: {}\n",
                                             user_doc.username, user_doc.public_id
                ));
            }
            Err(e) => { // Логування помилки під час отримання даних користувача
                eprintln!("Помилка при читанні користувача: {:?}", e);
            }
        }
    }
    // Надсилання сформованого списку користувачів
    tx.send(Message::Text(user_list)).unwrap_or_else(|e| {
        eprintln!("Помилка надсилання списку користувачів: {:?}", e);
    });

    Ok(())
}




async fn handle_message(
    text: &str,
    current_public_id: &Option<String>,
    db: &Database,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
    clients: &ClientsMap,
) -> Result<(), Box<dyn std::error::Error>> {

    // Розділення вхідного тексту на три частини: команда, отримувач, текст повідомлення
    let parts: Vec<&str> = text.splitn(3, ':').collect();
    if parts.len() == 3 { // Перевірка коректності формату команди
        let receiver_public_id = parts[1].trim(); // Отримувач
        let message_text = parts[2].trim(); // Текст повідомлення


        //// Перевірка аутентифікації відправника
        if let Some(sender_public_id) = current_public_id {
            // Створення нового повідомлення
            let new_message = DbMessage {
                sender_public_id: sender_public_id.clone(), // Публічний ID відправника
                receiver_public_id: receiver_public_id.to_string(), // Публічний ID отримувача
                message: message_text.to_string(), // Текст повідомлення
                timestamp: Utc::now().to_rfc3339(), // Час створення у форматі RFC 3339
                read: false, // Відзначаємо, що повідомлення ще не прочитане
            };

            // Додавання повідомлення в базу даних
            db.add_message(new_message).await?;

            // Надсилання відповіді відправнику
            tx.send(Message::Text(format!(
                "Ехо: Ви ({}) -> {}: {}",
                sender_public_id, receiver_public_id, message_text
            )))
                .unwrap_or_else(|e| {
                    eprintln!("Помилка надсилання ехо-повідомлення: {:?}", e);
                });

            // Перевірка, чи отримувач онлайн
            let clients_lock = clients.lock().await;
            if let Some(receiver_tx) = clients_lock.get(receiver_public_id) {
                // Надсилання оновлення чату отримувачу
                receiver_tx
                    .send(Message::Text("update_chat".to_string()))
                    .unwrap_or_else(|e| {
                        eprintln!("Помилка надсилання повідомлення отримувачу: {:?}", e);
                    });
            }
        } else {
            // Користувач не аутентифікований
            tx.send(Message::Text("msg fail: not authenticated".to_string()))
                .unwrap_or_else(|e| {
                    eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
                });
        }
    } else {
        // Невірний формат команди
        tx.send(Message::Text("msg fail: invalid format".to_string()))
            .unwrap_or_else(|e| {
                eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
            });
    }

    Ok(())
}


async fn handle_file_common(
    text: &str,
    current_public_id: &Option<String>,
    db: &Database,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
    clients: &ClientsMap,
    is_instant: bool, // Вказує, чи це інстант-файл чи звичайний файл
) -> Result<(), Box<dyn std::error::Error>> {

    // Розділення вхідного тексту на частини
    let parts: Vec<&str> = text.split(':').collect();
    // Перевірка формату вхідного тексту
    if parts.len() == 6 {
        let receiver_public_id = parts[1].trim(); // Публічний ID отримувача
        let file_name = parts[2].trim(); // Ім'я файлу
        let file_size = parts[3].trim(); // Розмір файлу
        let file_ext = parts[4].trim(); // Розширення файлу
        let file_base64 = parts[5].trim(); // Файл у вигляді Base64

        // Перевірка, чи користувач аутентифікований
        if let Some(sender_public_id) = current_public_id {
            // Спроба декодування Base64
            match decode(file_base64) {
                Ok(file_data) => {    // Створення директорії для зберігання файлу
                    let storage_path = format!("src/CloudStorage/{}", sender_public_id);
                    if let Err(e) = fs::create_dir_all(&storage_path) {
                        eprintln!(
                            "Помилка створення папки для користувача {}: {:?}",
                            sender_public_id, e
                        );
                    }
                    // Запис файлу у директорію
                    let file_path = format!("{}/{}", storage_path, file_name);
                    if let Err(e) = fs::write(&file_path, &file_data) {
                        eprintln!("Помилка запису файлу {}: {:?}", file_path, e);
                    } else {
                        println!(
                            "{} файл {} збережено для відправника {}",
                            if is_instant { "Інстант-" } else { "" },
                            file_path,
                            sender_public_id
                        );
                        // Формування тексту повідомлення
                        let message_text = if is_instant {
                            format!(
                                "file_instant:{}:{}:{}:{}:{}",
                                receiver_public_id, file_name, file_size, file_ext, file_base64
                            )
                        } else {
                            format!("file:{}:{}:{}", file_name, file_size, file_ext)
                        };
                        // Створення нового повідомлення
                        let new_message = DbMessage {
                            sender_public_id: sender_public_id.clone(), // Відправник
                            receiver_public_id: receiver_public_id.to_string(), // Отримувач
                            message: message_text, // Текст повідомлення
                            timestamp: Utc::now().to_rfc3339(), // Час створення
                            read: false, // Повідомлення не прочитане
                        };

                        // Додавання повідомлення у базу даних
                        db.add_message(new_message).await?;

                        // Надсилання підтвердження відправнику
                        tx.send(Message::Text(format!(
                            "{} файл {} відправлено користувачу {}",
                            if is_instant { "Інстант-" } else { "" },
                            file_name, receiver_public_id
                        )))
                            .unwrap_or_else(|e| {
                                eprintln!("Помилка надсилання підтвердження: {:?}", e);
                            });
                        // Перевірка, чи отримувач онлайн
                        let clients_lock = clients.lock().await;
                        if let Some(receiver_tx) = clients_lock.get(receiver_public_id) {
                            // Надсилання оновлення чату отримувачу
                            let update_message = if is_instant {
                                "update_chat:instant"
                            } else {
                                "update_chat"
                            };
                            receiver_tx
                                .send(Message::Text(update_message.to_string()))
                                .unwrap_or_else(|e| {
                                    eprintln!("Помилка надсилання повідомлення отримувачу: {:?}", e);
                                });
                        }
                    }
                }
                Err(e) => { // Помилка декодування Base64
                    eprintln!("Помилка декодування Base64: {:?}", e);
                    tx.send(Message::Text(format!(
                        "{} fail: base64 decode error",
                        if is_instant { "file_instant" } else { "file" }
                    )))
                        .unwrap_or_else(|e| {
                            eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
                        });
                }
            }
        } else {  // Користувач не аутентифікований
            tx.send(Message::Text(format!(
                "{} fail: not authenticated",
                if is_instant { "file_instant" } else { "file" }
            )))
                .unwrap_or_else(|e| {
                    eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
                });
        }
    } else { // Невірний формат команди
        tx.send(Message::Text(format!(
            "{} fail: invalid format",
            if is_instant { "file_instant" } else { "file" }
        )))
            .unwrap_or_else(|e| {
                eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
            });
    }

    Ok(())
}



async fn handle_get_chat(
    text: &str,
    db: &Database,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Розділення вхідного тексту на частини
    let parts: Vec<&str> = text.split(':').collect();

    // Перевірка формату команди
    if parts.len() == 3 {
        let sender_id = parts[1].trim(); // ID відправника
        let receiver_id = parts[2].trim(); // ID отримувача

        // Отримання історії чату з бази даних
        match db.get_chat_history(sender_id, receiver_id).await {
            Ok(messages) => { // Формування відповіді з історією чату
                let mut response = String::from("chat_history:\n");
                if !messages.is_empty() {
                    for message in messages {
                        // Видалення символів нових рядків для коректного виводу
                        let msg_text = message.message.replace('\n', " ");
                        response.push_str(&format!(
                            "{}|{}|{}\n", // Формат: ID відправника | Час | Текст повідомлення
                            message.sender_public_id,
                            message.timestamp,
                            msg_text
                        ));
                    }
                }
                // Надсилання історії чату клієнту
                tx.send(Message::Text(response))
                    .unwrap_or_else(|e| {
                        eprintln!("Помилка надсилання історії чату: {:?}", e);
                    });
            }
            Err(e) => {
                eprintln!("Помилка отримання історії чату: {:?}", e);
                tx.send(Message::Text("chat_history:\n".to_string()))
                    .unwrap_or_else(|e| {
                        eprintln!("Помилка надсилання порожньої історії чату: {:?}", e);
                    });
            }
        }
    } else {
        // Невірний формат команди
        tx.send(Message::Text("chat_history:\n".to_string()))
            .unwrap_or_else(|e| {
                eprintln!("Помилка надсилання порожньої історії чату: {:?}", e);
            });
    }

    Ok(())
}

async fn handle_get_file(
    text: &str,
    current_public_id: &Option<String>,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Розділення тексту на частини
    let parts: Vec<&str> = text.split(':').collect();

    // Перевірка коректності формату команди
    if parts.len() == 3 {
        let req_public_id = parts[1].trim(); // Публічний ID користувача, у якого запитується файл
        let req_file_name = parts[2].trim(); // Назва файлу

        // Перевірка, чи користувач аутентифікований
        if current_public_id.is_some() {
            // Формування шляху до запитуваного файлу
            let file_path = format!("src/CloudStorage/{}/{}", req_public_id, req_file_name);
            match fs::read(&file_path) {
                Ok(file_data) => {
                    // Кодування даних файлу в Base64
                    let base64_str = encode(&file_data);
                    let response = format!("file_data:{}:{}", req_file_name, base64_str);

                    // Надсилання даних файлу клієнту
                    tx.send(Message::Text(response))
                        .unwrap_or_else(|e| {
                            eprintln!("Помилка надсилання даних файлу: {:?}", e);
                        });
                }
                Err(e) => {
                    // Помилка читання файлу
                    eprintln!("Помилка читання файлу {}: {:?}", file_path, e);
                    tx.send(Message::Text("file_data_fail:file not found".to_string()))
                        .unwrap_or_else(|e| {
                            eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
                        });
                }
            }
        } else {
            // Користувач не аутентифікований
            tx.send(Message::Text("file_data_fail:not authenticated".to_string()))
                .unwrap_or_else(|e| {
                    eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
                });
        }
    } else {
        // Невірний формат команди
        tx.send(Message::Text("file_data_fail:invalid format".to_string()))
            .unwrap_or_else(|e| {
                eprintln!("Помилка надсилання повідомлення про помилку: {:?}", e);
            });
    }

    Ok(())
}
