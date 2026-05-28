const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Dynamic Word Bank
const WORD_BANK = {
    easy: ["cat", "dog", "sun", "tree", "house", "apple", "cup", "hat", "ball", "fish", "book", "door"],
    medium: ["guitar", "bicycle", "volcano", "pyramid", "computer", "snowman", "airplane", "octopus", "cactus"],
    hard: ["spaceship", "underground", "gravity", "architect", "lighthouse", "scarecrow", "microscope"]
};

const rooms = {};

// Helper: Generate Random Room Code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper: Get random words
function getRandomWords(count = 3, difficulty = 'easy') {
    const list = WORD_BANK[difficulty] || WORD_BANK.easy;
    const shuffled = [...list].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
    let currentRoomId = null;
    let nickname = '';

    // Create Room
    socket.on('createRoom', ({ name, maxPlayers, rounds, drawTime, difficulty }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId,
            hostId: socket.id,
            players: [],
            status: 'lobby', // lobby, selecting, drawing, ended
            settings: {
                maxPlayers: parseInt(maxPlayers) || 8,
                rounds: parseInt(rounds) || 3,
                drawTime: parseInt(drawTime) || 60,
                difficulty: difficulty || 'easy'
            },
            currentRound: 1,
            drawerIndex: 0,
            currentWord: '',
            wordsToSelect: [],
            guessedPlayers: [],
            roundTimer: null,
            timerValue: 0,
            canvasHistory: []
        };

        joinPlayerToRoom(roomId, name);
    });

    // Join Room
    socket.on('joinRoom', ({ roomId, name }) => {
        const id = roomId.toUpperCase();
        if (!rooms[id]) {
            socket.emit('errorMsg', 'Room not found.');
            return;
        }
        const room = rooms[id];
        if (room.players.length >= room.settings.maxPlayers) {
            socket.emit('errorMsg', 'Room is full.');
            return;
        }
        if (room.status !== 'lobby') {
            socket.emit('errorMsg', 'Game has already started.');
            return;
        }

        joinPlayerToRoom(id, name);
    });

    function joinPlayerToRoom(roomId, name) {
        currentRoomId = roomId;
        nickname = name || `Guest_${socket.id.substring(0, 4)}`;

        const room = rooms[roomId];
        const isHost = room.hostId === socket.id;

        const player = {
            id: socket.id,
            name: nickname,
            score: 0,
            isHost: isHost,
            streak: 0,
            hasGuessed: false
        };

        room.players.push(player);
        socket.join(roomId);

        // Notify client
        socket.emit('roomJoined', { roomId, player, settings: room.settings });
        
        // Notify all in room
        io.to(roomId).emit('roomData', {
            players: room.players,
            status: room.status,
            currentRound: room.currentRound,
            rounds: room.settings.rounds
        });

        sendSystemMessage(roomId, `${nickname} joined the room.`);
    }

    // Start Game
    socket.on('startGame', () => {
        const room = rooms[currentRoomId];
        if (!room || room.hostId !== socket.id) return;

        room.status = 'selecting';
        room.currentRound = 1;
        room.drawerIndex = 0;
        startTurnSelection(room);
    });

    // Start the word selection phase for the current drawer
    function startTurnSelection(room) {
        room.status = 'selecting';
        room.guessedPlayers = [];
        room.players.forEach(p => p.hasGuessed = false);
        room.canvasHistory = [];

        // Determine current drawer
        const drawer = room.players[room.drawerIndex % room.players.length];
        if (!drawer) return;

        // Generate 3 words
        room.wordsToSelect = getRandomWords(3, room.settings.difficulty);

        io.to(room.id).emit('stateChange', {
            status: 'selecting',
            drawerName: drawer.name,
            drawerId: drawer.id,
            round: room.currentRound
        });

        // Send options directly to the drawer
        io.to(drawer.id).emit('wordOptions', room.wordsToSelect);

        // 15 second timer for word selection
        clearInterval(room.roundTimer);
        room.timerValue = 15;
        io.to(room.id).emit('timerUpdate', room.timerValue);

        room.roundTimer = setInterval(() => {
            room.timerValue--;
            io.to(room.id).emit('timerUpdate', room.timerValue);

            if (room.timerValue <= 0) {
                clearInterval(room.roundTimer);
                // Auto-select first word if drawer fails to choose
                selectWord(room, room.wordsToSelect[0]);
            }
        }, 1000);
    }

    // Handle Word Selection
    socket.on('selectWord', (word) => {
        const room = rooms[currentRoomId];
        if (!room || room.status !== 'selecting') return;

        const drawer = room.players[room.drawerIndex % room.players.length];
        if (socket.id !== drawer.id) return; // Only drawer can select

        clearInterval(room.roundTimer);
        selectWord(room, word);
    });

    function selectWord(room, word) {
        room.currentWord = word.toLowerCase();
        room.status = 'drawing';

        const drawer = room.players[room.drawerIndex % room.players.length];

        // Broadcast turn details (obfuscate word for non-drawers)
        const maskedWord = room.currentWord.replace(/[a-zA-Z]/g, '_ ');
        
        // Send actual word to drawer, and hint to others
        room.players.forEach(p => {
            if (p.id === drawer.id) {
                io.to(p.id).emit('turnStarted', {
                    status: 'drawing',
                    word: room.currentWord,
                    drawerName: drawer.name,
                    drawerId: drawer.id
                });
            } else {
                io.to(p.id).emit('turnStarted', {
                    status: 'drawing',
                    word: maskedWord,
                    drawerName: drawer.name,
                    drawerId: drawer.id
                });
            }
        });

        // Start drawing timer
        room.timerValue = room.settings.drawTime;
        io.to(room.id).emit('timerUpdate', room.timerValue);

        room.roundTimer = setInterval(() => {
            room.timerValue--;
            io.to(room.id).emit('timerUpdate', room.timerValue);

            // Time ended
            if (room.timerValue <= 0) {
                endTurn(room, "Time's up!");
            }
        }, 1000);
    }

    // Real-time canvas sync (Uses normalized coords: 0.0 - 1.0)
    socket.on('draw', (data) => {
        const room = rooms[currentRoomId];
        if (!room || room.status !== 'drawing') return;

        const drawer = room.players[room.drawerIndex % room.players.length];
        if (socket.id !== drawer.id) return;

        room.canvasHistory.push(data);
        socket.to(room.id).emit('drawSync', data);
    });

    socket.on('clearCanvas', () => {
        const room = rooms[currentRoomId];
        if (!room) return;
        const drawer = room.players[room.drawerIndex % room.players.length];
        if (socket.id !== drawer.id) return;

        room.canvasHistory = [];
        io.to(room.id).emit('clearCanvasSync');
    });

    // Chat / Guess Validation
    socket.on('chatMessage', (msgText) => {
        const room = rooms[currentRoomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const cleanMsg = msgText.trim();
        const drawer = room.players[room.drawerIndex % room.players.length];

        if (room.status === 'drawing' && socket.id !== drawer.id) {
            // Check if player already guessed
            if (player.hasGuessed) {
                // If they've already guessed, they talk in a "guessed pool"
                room.players.forEach(p => {
                    if (p.hasGuessed || p.id === drawer.id) {
                        io.to(p.id).emit('chatSync', { sender: player.name, text: cleanMsg, solved: true });
                    }
                });
                return;
            }

            // Check guess
            if (cleanMsg.toLowerCase() === room.currentWord) {
                player.hasGuessed = true;
                room.guessedPlayers.push(player.id);

                // Calculate point distribution based on remaining speed
                const maxTime = room.settings.drawTime;
                const ratio = room.timerValue / maxTime;
                const basePoints = Math.floor(ratio * 150) + 100; // 100 to 250 points

                // Streak Bonus
                player.streak++;
                const streakBonus = player.streak > 1 ? (player.streak * 10) : 0;
                player.score += (basePoints + streakBonus);

                // Drawer earns points per guess
                if (drawer) {
                    drawer.score += 35;
                }

                io.to(room.id).emit('chatSync', {
                    sender: 'System',
                    text: `${player.name} guessed the word!`,
                    isSystem: true,
                    isSuccess: true
                });

                // Update players list on client to show checkmarks
                io.to(room.id).emit('roomData', {
                    players: room.players,
                    status: room.status,
                    currentRound: room.currentRound,
                    rounds: room.settings.rounds
                });

                // Check if all non-drawers guessed correctly
                const activeGuessersCount = room.players.length - 1;
                if (room.guessedPlayers.length >= activeGuessersCount) {
                    // Everyone guessed correctly bonus
                    if (drawer) drawer.score += 50;
                    endTurn(room, "Everyone guessed the word!");
                }
                return;
            }
        }

        // Regular chat broadcast
        io.to(room.id).emit('chatSync', { sender: player.name, text: cleanMsg });
    });

    function endTurn(room, reason) {
        clearInterval(room.roundTimer);

        io.to(room.id).emit('chatSync', {
            sender: 'System',
            text: `${reason} The word was: "${room.currentWord.toUpperCase()}"`,
            isSystem: true
        });

        // Update score statistics
        io.to(room.id).emit('roomData', {
            players: room.players,
            status: room.status,
            currentRound: room.currentRound,
            rounds: room.settings.rounds
        });

        // Determine next state
        room.drawerIndex++;
        
        // If a full cycle has completed, advance round
        if (room.drawerIndex % room.players.length === 0) {
            room.currentRound++;
        }

        // Check if game has concluded
        if (room.currentRound > room.settings.rounds) {
            room.status = 'ended';
            // Find overall winner
            const sorted = [...room.players].sort((a, b) => b.score - a.score);
            const winner = sorted[0];

            io.to(room.id).emit('stateChange', {
                status: 'ended',
                leaderboard: sorted,
                winner: winner
            });
        } else {
            // Pause 4 seconds to show scores before next round
            setTimeout(() => {
                if (rooms[room.id]) {
                    startTurnSelection(room);
                }
            }, 4000);
        }
    }

    function sendSystemMessage(roomId, text) {
        io.to(roomId).emit('chatSync', { sender: 'System', text: text, isSystem: true });
    }

    // Kick Player (Host Command)
    socket.on('kickPlayer', (targetSocketId) => {
        const room = rooms[currentRoomId];
        if (!room || room.hostId !== socket.id) return;

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.emit('kicked');
            targetSocket.leave(room.id);
            handleLeave(targetSocketId);
        }
    });

    // Handle Leave/Disconnect
    socket.on('disconnect', () => {
        handleLeave(socket.id);
    });

    function handleLeave(socketId) {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        const pIndex = room.players.findIndex(p => p.id === socketId);
        if (pIndex !== -1) {
            const leavingPlayer = room.players[pIndex];
            room.players.splice(pIndex, 1);
            
            sendSystemMessage(room.id, `${leavingPlayer.name} disconnected.`);

            // Reset streak
            leavingPlayer.streak = 0;

            if (room.players.length === 0) {
                // Delete empty rooms
                clearInterval(room.roundTimer);
                delete rooms[room.id];
                return;
            }

            // Assign new host if host left
            if (room.hostId === socketId) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
                sendSystemMessage(room.id, `${room.players[0].name} is now the host.`);
            }

            // Handle middle-of-turn disconnections
            if (room.status === 'drawing' || room.status === 'selecting') {
                const currentDrawerId = room.players[room.drawerIndex % (room.players.length + 1)]?.id;
                if (!currentDrawerId || currentDrawerId === socketId) {
                    endTurn(room, "The drawer left the room!");
                }
            }

            io.to(room.id).emit('roomData', {
                players: room.players,
                status: room.status,
                currentRound: room.currentRound,
                rounds: room.settings.rounds
            });
        }
    }
});

server.listen(PORT, () => {
    console.log(`Socket.IO Server listening dynamic on port ${PORT}`);
});