// Minimal RELINK chat prototype (Render-ready)
// Backend: Node.js + Express + Socket.IO

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // Serve frontend files

// Store rooms and users in memory
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;
  let username = null;

  socket.on('setUsername', (name) => {
    username = name;
    socket.emit('usernameSet', name);
  });

  socket.on('createRoom', (roomName) => {
    if (!rooms[roomName]) {
      rooms[roomName] = [];
    }
    socket.join(roomName);
    currentRoom = roomName;
    rooms[roomName].push(username);
    io.to(currentRoom).emit('userList', rooms[currentRoom]);
    socket.emit('roomJoined', roomName);
  });

  socket.on('joinRoom', (roomName) => {
    if (rooms[roomName]) {
      socket.join(roomName);
      currentRoom = roomName;
      rooms[roomName].push(username);
      io.to(currentRoom).emit('userList', rooms[currentRoom]);
      socket.emit('roomJoined', roomName);
    } else {
      socket.emit('error', 'Room does not exist');
    }
  });

  socket.on('sendMessage', (msg) => {
    if (currentRoom) {
      io.to(currentRoom).emit('newMessage', { username, msg });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom] = rooms[currentRoom].filter(user => user !== username);
      io.to(currentRoom).emit('userList', rooms[currentRoom]);
    }
  });
});

// Use Render's PORT environment variable if it exists
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`RELINK backend running on port ${PORT}`);
});
