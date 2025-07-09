import cloudinary from "../config/cloudinary.js"

const deleteMediaByMessages = async (messageList) => {

    for (const msg of messageList) {

        console.log(`🔎 Checking message ${msg.id}`);

        if (!msg.data().public_id) continue;

        try {
            const resourceType = msg.data().type === "audio" ? "video" : "image";

            await cloudinary.uploader.destroy(msg.data().public_id, {
                resource_type: resourceType,
            });

            console.log(`🧹 Deleted ${resourceType} →`, msg.data().public_id);

        } catch (err) {
            console.error(`❌ Failed to delete ${msg.data().public_id}`, err.message);
        }
    }
}

export default deleteMediaByMessages;