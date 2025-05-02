const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Replace with frontend URL in production
  },
});

app.use(cors());
app.use(express.json());

const defaultAvatarUrl =
  "https://res.cloudinary.com/dr2f4tmgc/image/upload/v1745903350/20171206_01_yj5lwe.jpg";

const dbPath = path.join(__dirname, "chatbox.db");
let db;

async function initDb() {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Create tables if not exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      avatarurl TEXT,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT,
      receiver_id TEXT,
      message_text TEXT,
      timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      created_at TEXT,
      created_by TEXT
    );
  `);
}
initDb();

const connectedUsers = {}; // userId => socket.id
const typingUsers = {}; // { receiverId: Set<userId> }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register", (userId) => {
    connectedUsers[userId] = socket.id;
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  socket.on("send_message", async (data) => {
    const { senderId, receiverId, message } = data;
    const timestamp = getTimeStamp();
    const id = uuidv4();

    try {
      await db.run(
        `INSERT INTO messages (id, sender_id, receiver_id, message_text, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
        [id, senderId, receiverId, message, timestamp]
      );

      const receiverSocketId = connectedUsers[receiverId];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("receive_message", {
          id,
          senderId,
          receiverId,
          message,
          timestamp,
        });
      }

      socket.emit("message_sent", {
        id,
        receiverId,
        message,
        timestamp,
      });
    } catch (err) {
      console.error("Error saving message:", err);
      socket.emit("error_message", { error: "Failed to send message." });
    }
  });

  socket.on("disconnect", () => {
    for (const [userId, sId] of Object.entries(connectedUsers)) {
      if (sId === socket.id) {
        delete connectedUsers[userId];
        console.log(`User ${userId} disconnected`);
        break;
      }
    }
  });

  // In-memory tracking

  socket.on("typing", ({ senderId, receiverId }) => {
    if (!typingUsers[receiverId]) typingUsers[receiverId] = new Set();
    typingUsers[receiverId].add(senderId);

    const receiverSocketId = connectedUsers[receiverId];
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("user_typing", { senderId });
    }
  });

  socket.on("stop_typing", ({ senderId, receiverId }) => {
    if (typingUsers[receiverId]) {
      typingUsers[receiverId].delete(senderId);
      if (typingUsers[receiverId].size === 0) delete typingUsers[receiverId];
    }

    const receiverSocketId = connectedUsers[receiverId];
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("user_stopped_typing", { senderId });
    }
  });
});

// ==============================
// JWT Middleware
// ==============================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(400).send({ message: "Missing token" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(401).send({ message: "Invalid token" });
    req.userId = payload.userId;
    next();
  });
}

// ==============================
// Routes
// ==============================

app.post("/signup", async (req, res) => {
  const { username, password, avatarurl = defaultAvatarUrl } = req.body;

  try {
    const existing = await db.get("SELECT * FROM users WHERE username = ?", [
      username,
    ]);
    if (existing)
      return res.status(400).send({ message: "User already exists." });

    const hashed = await bcrypt.hash(password, 10);
    await db.run(
      "INSERT INTO users (id, username, password, avatarurl, status) VALUES (?, ?, ?, ?, ?)",
      [uuidv4(), username, hashed, avatarurl, "Offline"]
    );

    res.status(201).send({ message: "User registered successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await db.get("SELECT * FROM users WHERE username = ?", [
      username,
    ]);
    if (!user) return res.status(404).send({ message: "User not found" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).send({ message: "Invalid password" });

    const jwtToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.status(200).send({ jwtToken, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

app.get("/dashboard", authenticateToken, async (req, res) => {
  const { userId } = req;
  try {
    const rooms = await db.all("SELECT * FROM rooms");
    const users = await db.all(
      "SELECT id, username, avatarurl, status FROM users WHERE id != ?",
      [userId]
    );
    res.status(200).send({ publicRooms: rooms, users });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

app.post("/createroom", authenticateToken, async (req, res) => {
  const { name } = req.body;
  const { userId } = req;
  const id = uuidv4();
  const createdAt = getTimeStamp();

  try {
    const existing = await db.get("SELECT * FROM rooms WHERE name = ?", [name]);
    if (existing)
      return res.status(400).send({ message: "Room already exists" });

    await db.run(
      "INSERT INTO rooms (id, name, created_at, created_by) VALUES (?, ?, ?, ?)",
      [id, name, createdAt, userId]
    );

    res.status(201).send({ message: "Room created!", roomId: id });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Something went wrong." });
  }
});

// ✅ Get messages for a conversation
app.get("/messages/:receiverId", authenticateToken, async (req, res) => {
  const { userId } = req;
  const { receiverId } = req.params;

  try {
    const messages = await db.all(
      `SELECT * FROM messages
       WHERE (sender_id = ? AND receiver_id = ?)
       OR (sender_id = ? AND receiver_id = ?)
       ORDER BY timestamp ASC`,
      [userId, receiverId, receiverId, userId]
    );

    res.status(200).send(messages);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

// ==============================
// Utils
// ==============================
function getTimeStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(now.getDate()).padStart(2, "0")} ${String(
    now.getHours()
  ).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(
    now.getSeconds()
  ).padStart(2, "0")}`;
}

// ==============================
// Server
// ==============================
server.listen(4004, () => {
  console.log("Server running on http://localhost:4004");
});
