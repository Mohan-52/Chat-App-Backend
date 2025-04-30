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
    origin: "*", // change to your frontend URL in production
  },
});

app.use(cors());
app.use(express.json());

const defaultAvatarUrl =
  "https://res.cloudinary.com/dr2f4tmgc/image/upload/v1745903350/20171206_01_yj5lwe.jpg";

const dbPath = path.join(__dirname, "chatbox.db");
let db;

// ==============================
// SQLite DB INIT
// ==============================
async function initDb() {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
}
initDb();

// ==============================
// Socket.io logic
// ==============================
const connectedUsers = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register", (userId) => {
    connectedUsers[userId] = socket.id;
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  socket.on("send_message", async ({ senderId, receiverId, message }) => {
    const timestamp = getTimeStamp();

    await db.run(
      "INSERT INTO messages (id, sender_id, conversation_id, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      [uuidv4(), senderId, receiverId, message, timestamp]
    );

    const receiverSocket = connectedUsers[receiverId];
    if (receiverSocket) {
      io.to(receiverSocket).emit("receive_message", {
        senderId,
        message,
        timestamp,
      });
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
// API Routes
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

    res.status(201).send({ message: "Room created!" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Something went wrong." });
  }
});

// ==============================
// Utilities
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
// Server Start
// ==============================
server.listen(4004, () => {
  console.log("Server is running on http://localhost:4004");
});
