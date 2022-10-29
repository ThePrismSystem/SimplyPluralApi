import { getCollection } from "../../mongo";
import { syncOptions } from "./sync";
import { ObjectId } from "mongodb";

export enum PkSyncType {
	Insert,
    Delete,
    Update
}

export interface PkSyncData {
    live: boolean,
    frontingDocId: string,
    oldFrontingDoc: SPFrontHistoryEntry | null,
    newFrontingDoc: SPFrontHistoryEntry | null
}

export interface SPFrontHistoryEntry {
    _id: ObjectId,
    custom: boolean,
    live: boolean,
    startTime: number,
    endTime: number | null,
    member: string,
    uid: string,
    lastOperationTime: number
}

export interface PkSync {
	_id: string | ObjectId,
	uid: string,
	token: string,
    syncOptions: syncOptions,
	type: PkSyncType,
	data: PkSyncData
}

export interface PkQueuedSync {
	_id: string,
    uid: string,
    timestamp: number,
	sync: PkSync
}

export const addPendingSync = async (sync: PkSync) => getCollection(`pkQueuedSyncs`).insertOne({ _id: sync._id, uid: sync.uid, timestamp: Date.now(), sync });

export const startPkSyncController = () => {
	reportActiveQueueSize();
	deleteOldQueuedSyncs();
}

export const getSyncQueueSize = () => getCollection(`pkQueuedSyncs`).countDocuments();

export const reportActiveQueueSize = async () => {
	const syncQueueSize = await getSyncQueueSize();

	console.log(`Active pk sync controller queue size: ${syncQueueSize.toString()}`);

	setTimeout(reportActiveQueueSize, 10000);
}

// Delete any queued syncs that have been in the queue for longer than 24 hours (this prevents user's pk tokens from being stored for too long)
export const deleteOldQueuedSyncs = async () => {
	await getCollection("pkQueuedSyncs").deleteMany({ timestamp: { $lte: Date.now() - 86400000 } });

	setTimeout(deleteOldQueuedSyncs, 10000);
}

export const removeQueuedSync = async (sync: PkSync) => getCollection(`pkQueuedSyncs`).deleteOne({ _id: sync._id });

export const removeAllQueuedSyncsForUser = async (uid: string) => getCollection("pkQueuedSyncs").deleteMany({ uid });

export const getAllQueuedSyncsForUser = async (uid: string): Promise<PkQueuedSync[]> => getCollection("pkQueuedSyncs").find({ uid }).toArray();