const express = require("express");
const app = express();
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

/* const { createServer } = require("http");
const { Server } = require("socket.io");

const httpServer = createServer(app);

const io = new Server(httpServer);

io.on("connection", (socket) => {
  // ...
});

httpServer.listen(3000); */

const defaultAvatarUrl =
  "https://res.cloudinary.com/dr2f4tmgc/image/upload/v1745903350/20171206_01_yj5lwe.jpg";
app.use(express.json());
app.use(cors());
require("dotenv").config();

const dbPath = path.join(__dirname, "chatbox.db");

let db;
async function initServerAndDb() {
  try {
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    app.listen(4004, () => {
      console.log("The server is running at port 4004");
    });
  } catch (error) {
    console.log(error);
  }
}

initServerAndDb();

app.post("/signup", async (req, res) => {
  const { username, password, avatarurl = defaultAvatarUrl } = req.body;
  try {
    const existing = await db.get("SELECT * FROM users WHERE username = ?", [
      username,
    ]);

    if (existing)
      return res.status(400).send({ message: "User already exists." });

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = uuidv4();

    await db.run(
      "INSERT INTO users (id,username, password, avatarurl, status) VALUES (?,?, ?, ?, ?)",
      [id, username, hashedPassword, avatarurl, "Offline"]
    );

    res.status(201).send({ message: "User registered successfully." });
  } catch (error) {
    res.status(500).send({ message: "Internal Server Error" });
    console.log(error);
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await db.get("SELECT * FROM users WHERE username = ?", [
      username,
    ]);
    if (!user) return res.status(404).send({ message: "User not found." });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword)
      return res.status(401).send({ message: "Invalid password." });

    const jwtToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.status(200).send({ jwtToken, name: user.name });
  } catch (error) {
    res.status(500).send({ message: "Internal Server Error" });
    console.log(error);
  }
});

async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader)
    return res.status(400).send({ message: "User not logged in" });

  const jwtToken = authHeader.split(" ")[1];

  jwt.verify(jwtToken, process.env.JWT_SECRET, async (err, payload) => {
    if (err) {
      return res.status(401).send({ message: "Invalid JWT token" });
    }

    req.userId = payload.userId;
    next();
  });
}

function getTimeStamp() {
  const now = new Date();
  const timestamp =
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0") +
    " " +
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0");

  return timestamp;
}

app.post("/createroom", authenticateToken, async (req, res) => {
  const { name } = req.body;
  const id = uuidv4();
  const createdAt = getTimeStamp();
  const { userId } = req;
  try {
    const existing = await db.get(`SELECT * FROM rooms WHERE name = ?`, [name]);
    if (existing)
      return res.status(400).send({ message: "Room already exists" });
    await db.run(
      "INSERT INTO rooms (id, name, created_at, created_by) VALUES (?, ?, ?, ?)",
      [id, name, createdAt, userId]
    );
    res.status(201).send({ message: "Room created!" });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Something went wrong." });
  }
});

app.get("/rooms", authenticateToken, async (req, res) => {
  try {
    const dbResponse = await db.all(`SELECT * FROM rooms`);
    res.status(200).send(dbResponse);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Internal Server Error" });
  }
});
