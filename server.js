import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import admin from './config/firebase.js';
import cors from 'cors';
import multer from 'multer';
import cloudinary from './config/cloudinary.js';
import fs from 'fs';
import deleteMediaByMessages from './utils/mediaDelete.js';
import bcrypt from 'bcrypt';
import { type } from 'os';


const app = express();
const PORT = 4000;
const saltRounds = 10;
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true }); // To prevents firestore undefined situation.

// app.use('/uploads', express.static('uploads'));
app.use(cors());
app.use(express.json()); // Parses incoming JSON requests.
app.set('trust proxy', 1); // Important for Render working...

// Multer setup for memory storage.
const imageUpload = multer({ dest: "temp/image" });
const audioUpload = multer({ dest: "temp/audio" })

// App routes.
app.post('/upload/img', imageUpload.single('image'), async (req, res) => {
    try {

        const result = await cloudinary.uploader.upload(req.file?.path, {
            folder: "chat_app_images",
        });

        // Delete temp file.
        fs.unlinkSync(req.file?.path);

        res.json({ public_id: result.public_id, url: result.secure_url });

    } catch (err) {
        console.error("Cloudinary image upload error:", err);
        res.status(500).json({ type: 'error', message: "Upload failed !" });
    }
});

app.post('/upload/audio', audioUpload.single('audio'), async (req, res) => {
    try {

        const result = await cloudinary.uploader.upload(req.file?.path, {
            resource_type: "video",
            folder: "chat_app_audio",
        });

        // Delete temp file.
        fs.unlinkSync(req.file?.path);

        res.json({ public_id: result.public_id, url: result.secure_url });

    } catch (err) {
        console.error("Cloudinary audio upload error:", err);
        res.status(500).json({ type: 'error', message: "Upload failed !" });
    }
});

app.post('/user/update', imageUpload.single('avatar'), async (req, res) => {
    try {

        const { public_id, username, uid } = req.body;

        // Check user name already used...
        if (username) {
            const usernameQuery = await db.collection('users').where('username', '==', username).limit(1).get();

            if (!usernameQuery.empty) {
                console.log('❌ Username already used!');
                return res.json({ message: 'Username already used!' });
            }
        }

        // Delete already uploaded avatar.
        try {
            if (public_id) {
                await cloudinary.uploader.destroy(public_id, {
                    resource_type: "image"
                });
                console.log(`🧹 Deleted image →`, public_id);
            }

        } catch (error) {
            console.error(`❌ Failed to delete ${public_id}`, err.message);
        }

        // Upload new avatar.
        let result = null;

        try {
            if (req.file?.path) {

                result = await cloudinary.uploader.upload(req.file?.path, {
                    folder: "chat_app_avatar",
                });

                // Delete temp file.
                fs.unlinkSync(req.file?.path);

            };
        } catch (error) {
            console.error("Cloudinary upload error:", error);
        }

        // Update payload..
        const updateData = {};

        // Only add username if it was sent.
        if (username) updateData.username = username;

        //  Only add avatar if uploaded.
        if (result) {
            updateData.avatar = result.secure_url;
            updateData.public_id = result.public_id;
        }

        // Only update if we actually have something to update..
        if (Object.keys(updateData).length > 0) {
            await db.collection('users').doc(uid).update(updateData);
            console.log('✅ Profile updated.');
            return res.json({ type: true, message: 'Profile updated.' });
        } else {
            console.log('⚠️ Nothing to update.');
            return res.json({ type: false, message: 'Nothing to update.' });
        }

    } catch (error) {
        console.error('Update error:', error);
        return res.status(500).json({ type: false, message: "Update failed !" });
    }
});


// Start HTTP server.
const server = app.listen(PORT, () => console.log(`Server is running on ${PORT} ☑️`))

// Attach WebSocket server to same HTTP server.
const wss = new WebSocketServer({ server });

// WebSocket logic.

wss.on('connection', (ws) => {

    console.log("Client connected ✅");

    // Send list of all available rooms.
    const sendRoomList = async () => {
        const snapShot = await db.collection('rooms').get();
        const rooms = snapShot.docs.map((doc) => ({
            name: doc.id,
            private: !!doc.data().password, // if no password - false.
            createdBy: doc.data().createdBy,
        }));

        // Send to every connected socket.
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'rooms-updated', rooms: rooms }));
            }
        });

    };
    sendRoomList();

    // Handling incoming messages from clients.
    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            const { action, roomName, username, text, replyTo, password, uid, public_id, type, msgId } = data;

            // Create room...
            if (action === 'create') {

                if (!roomName && !uid) return;

                const roomRef = db.collection('rooms').doc(roomName);
                const roomDoc = await roomRef.get();

                if (!roomDoc.exists) {

                    await roomRef.set({
                        password: password && await bcrypt.hash(password, saltRounds) || null,
                        createdBy: uid,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    });

                    sendRoomList(); //  Update to fetch from Firestore now.

                    ws.send(JSON.stringify({ type: 'create-success', roomName }
                    ));
                } else {
                    ws.send(JSON.stringify({ type: 'error', create: true, message: "Room already exist !" }));
                }
                return;
            }

            // Join room...
            if (action === 'join') {
                const roomRef = db.collection('rooms').doc(roomName);
                const roomDoc = await roomRef.get();


                // Check room is already exists.
                if (!roomDoc.exists) {
                    ws.send(JSON.stringify({ type: "error", join: true, message: "Room doesn't exist." }));
                    return;
                }

                // Check room password.
                const data = roomDoc.data();

                if (data.password) {
                    const matched = await bcrypt.compare(password, data.password);

                    if (!matched) {
                        ws.send(JSON.stringify({ type: "error", join: true, message: "Incorrect password." }));
                        return;
                    }
                }

                // Get all messages first.
                const messagesSnapshot = await roomRef.collection('messages').orderBy('timestamp').get();
                const messages = [];
                messagesSnapshot.forEach((msgDoc) => {
                    messages.push(msgDoc.data());
                });

                // And send room name and old messages...
                ws.send(JSON.stringify({
                    type: "join-success",
                    roomName,
                    messages
                }));

                return;
            }

            // Send message...
            if (action === 'message') {
                const roomRef = db.collection("rooms").doc(roomName);
                const roomDoc = await roomRef.get();

                // Check room already exist.
                if (!roomDoc.exists) return;

                // new message.
                const newMsg = {
                    id: Date.now().toString(),
                    userId: uid,
                    username,
                    text,
                    replyTo,
                    type: type || null,
                    public_id: public_id || null,
                    roomName,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    roomName,
                };

                // Store new message.
                await roomRef.collection('messages').doc(newMsg.id).set(newMsg);
                const msg = await roomRef.collection('messages').doc(newMsg.id).get()


                // Send messages for all client.
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: "message", message: msg.data() }));
                    }
                });

                return;
            }

            // Delete message.
            if (action === 'delete-message') {

                try {
                    const roomRef = db.collection("rooms").doc(roomName);
                    const messagesRef = roomRef.collection("messages");
                    const messageRef = messagesRef.doc(msgId);
                    const message = await messageRef.get();

                    if (message.data().userId === uid) {

                        // Delete audio or image files in cloudinary...
                        if (message.data()?.public_id) {

                            try {
                                const resourceType = message.data().type === "audio" ? "video" : "image";

                                await cloudinary.uploader.destroy(message.data().public_id, {
                                    resource_type: resourceType,
                                });

                                console.log(`🧹 Deleted ${resourceType} →`, message.data().public_id);

                            } catch (err) {
                                console.error(`❌ Failed to delete ${message.data().public_id}`, err.message);
                            }
                        };

                        // Delete message.
                        await messageRef.delete();
                        console.log('✅ message deleted...');

                        ws.send(JSON.stringify({
                            type: 'message-deleted', id: msgId,
                        }));

                    }

                } catch (error) {
                    console.error('❌ Message delete failed:', error);
                }

            }

            // Delete room...
            if (action === 'delete-room') {

                try {

                    const roomRef = db.collection("rooms").doc(roomName);
                    const roomDoc = await roomRef.get();

                    if (!roomDoc.exists) return; // No room exists

                    if (roomDoc.data().owner !== uid) {
                        ws.send(JSON.stringify({ type: "error", message: "Only the creator can delete this room." }));
                        return;
                    };

                    // Delete all messages.
                    const messagesRef = roomRef.collection("messages");
                    const messagesSnapshot = await messagesRef.get();

                    await deleteMediaByMessages(messagesSnapshot.docs);

                    // create a batch for delete all messages.
                    const batch = db.batch();

                    messagesSnapshot.forEach((doc) => batch.delete(doc.ref));
                    await batch.commit();

                    // Delete room doc.
                    await roomRef.delete();

                    sendRoomList(); // Update room list after deletion

                } catch (error) {
                    console.error('❌ Delete failed :', error);
                }

            }

            // Delete user account..
            if (action === 'delete-account') {

                if (!uid) return;

                try {

                    // Delete Auth user.
                    try {
                        await admin.auth().deleteUser(uid);
                        console.log('✅ Auth user deleted done.');

                    } catch (err) {
                        if (err.code === 'auth/user-not-found') {
                            console.log('ℹ️ Auth user already gone.');
                        } else {
                            throw err; // rethrow if serious.
                        }
                    }

                    // Delete user uploaded avatar.
                    const userSnapShot = await db.collection('users').doc(uid).get();

                    if (userSnapShot.data().public_id) {
                        try {
                            await cloudinary.uploader.destroy(userSnapShot.data().public_id, {
                                resource_type: "image"
                            });
                            console.log(`🧹 Deleted image →`, userSnapShot.data().public_id);

                        } catch (error) {
                            console.error(`❌ Failed to delete ${userSnapShot.data().public_id}`, err.message);
                        }
                    }

                    // Delete Firestore profile.
                    await db.collection('users').doc(uid).delete();
                    console.log('✅ Firestore profile deleted done.');

                    // For delete rooms / messages / media..
                    const roomSnap = await db.collection('rooms').where('createdBy', '==', uid).get();
                    console.log(`✅ Found ${roomSnap.size} rooms.`);

                    for (const room of roomSnap.docs) {
                        const roomId = room.id;
                        const messagesSnap = await db.collection('rooms').doc(roomId).collection('messages').get();

                        await deleteMediaByMessages(messagesSnap.docs);
                        console.log('✅ Media deleted done.');

                        await admin.firestore().recursiveDelete(db.collection('rooms').doc(roomId));
                        console.log(`✅ Room ${roomId} deleted done.`);
                    }

                    ws.send(JSON.stringify({
                        type: 'delete-success'
                    }));

                    sendRoomList(); // Update room list after deletion

                } catch (err) {
                    console.error('❌ Total delete failed:', err);
                }

            }


        } catch (error) {
            console.error('Error handling message:', error);
        }


    });

    ws.on('close', () => { console.log("Client disconnected ❌"); });

});