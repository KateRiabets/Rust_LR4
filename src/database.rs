
use mongodb::{
    options::ClientOptions,
    bson::doc,
    Client, Collection, error::Result as MongoResult,
};
use serde::{Deserialize, Serialize};
use futures_util::TryStreamExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct User {
    pub username: String,
    pub password: String,
    pub public_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub sender_public_id: String,
    pub receiver_public_id: String,
    pub message: String,
    pub timestamp: String,
    pub read: bool,
}

#[derive(Clone)]
pub struct Database {
    client: Client,
    db_name: String,
}

impl Database {
    // Створення нового екземпляру Database з підключенням до MongoDB
    pub async fn new(uri: &str, db_name: &str) -> MongoResult<Self> {
        // Парсинг URI для MongoDB (формат URI передає адресу сервера, порт та параметри з'єднання)
        let options = ClientOptions::parse(uri).await?;

        // Створення клієнта MongoDB із заданими опціями
        let client = Client::with_options(options)?;

        // Повернення нового екземпляра Database з клієнтом та назвою бази даних
        Ok(Self {
            client,                              // Клієнт MongoDB
            db_name: db_name.to_string(),       // Назва бази даних
        })
    }

    // Отримання колекції користувачів
    pub fn users_collection(&self) -> Collection<User> {
        // Вибір бази даних через self.db_name та доступ до колекції "users"
        self.client.database(&self.db_name).collection("users")
    }

    // Отримання колекції повідомлень
    pub fn messages_collection(&self) -> Collection<Message> {
        // Вибір бази даних через self.db_name та доступ до колекції "messages"
        self.client.database(&self.db_name).collection("messages")
    }

    // Додавання нового користувача до колекції "users"
    pub async fn add_user(&self, user: User) -> MongoResult<()> {
        // Отримання колекції користувачів
        let collection = self.users_collection();
        // Вставка нового користувача до колекції
        // insert_one - додає один документ у форматі моделі `User`
        collection.insert_one(user, None).await?;
        Ok(())
    }

    // Пошук користувача за username
    pub async fn find_user_by_username(&self, username: &str) -> MongoResult<Option<User>> {
        // Отримання колекції користувачів
        let collection = self.users_collection();
        // Створення фільтру : документ, де поле "username" = передане значення
        collection.find_one(doc! { "username": username }, None).await
    }

    // Додавання нового повідомлення до колекції "messages"
    pub async fn add_message(&self, message: Message) -> MongoResult<()> {
        // Отримання колекції повідомлень
        let collection = self.messages_collection();
        // Вставка нового повідомлення у колекцію
        collection.insert_one(message, None).await?;
        Ok(())
    }

    // Отримання історії чату між двома користувачами
    pub async fn get_chat_history(
        &self,
        sender_public_id: &str,
        receiver_public_id: &str,
    ) -> MongoResult<Vec<Message>> {
        // Отримання колекції повідомлень
        let collection = self.messages_collection();

        // Створення фільтру для пошуку повідомлень між двома користувачами
        let filter = doc! {
            "$or": [ //  $or шукає повідомлення, що відповідають хоча б одній умові:
                { "sender_public_id": sender_public_id, "receiver_public_id": receiver_public_id }, // Відправник -> Одержувач
                { "sender_public_id": receiver_public_id, "receiver_public_id": sender_public_id } // Одержувач -> Відправник
            ]
        };
        // Виконання запиту до бази даних із фільтром
        let cursor = collection.find(filter, None).await?;
        // Перетворення курсора в список повідомлень (модель `Message`) через try_collect()
        let messages: Vec<Message> = cursor.try_collect().await?;
        Ok(messages)
    }
}
