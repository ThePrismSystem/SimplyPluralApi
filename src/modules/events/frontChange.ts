import { notifyUser } from "../../util";
import { logger } from "../logger";
import { getCollection, parseId } from "../mongo";
import { notifyOfFrontChange } from "./automatedReminder";
import { performEvent } from "./eventController";
import { syncDeletedSwitchToPk, syncMembersNotInPk, syncNewSwitchToPk, syncOptions, syncUpdatedSwitchToPk } from "../integrations/pk/sync";
import { addPendingSync, getAllQueuedSyncsForUser, PkQueuedSync, PkSyncType, removeMultipleQueuedSyncs, removeQueuedSync, SPFrontHistoryEntry } from "../integrations/pk/syncController";
import { ObjectId } from "mongodb";

export const initiateFrontSyncToPk = async (uid: string, _event: any) => {
	// Get all applicable front sync events for the user
	const userPkQueuedSyncs = await getAllQueuedSyncsForUser(uid);

	console.log('userPkQueuedSyncs', userPkQueuedSyncs);

	// Sync any members within these syncs to pk if they don't already exist in pk
	let memberIds: string[] = [];

	userPkQueuedSyncs.forEach((sync) => {
		const syncFrontingDoc = sync.sync.data.newFrontingDoc || sync.sync.data.oldFrontingDoc;

		if (syncFrontingDoc !== null) {
			memberIds.push(syncFrontingDoc.member);
		}
	});

	// De-dupe member ids
	memberIds = [...new Set(memberIds)];

	console.log('memberIds', memberIds);

	if (memberIds.length) {
		const spMembers = await getCollection('members').find({ uid, _id: { '$in': memberIds.map((memberId) => parseId(memberId)) }}).toArray();
		const token = userPkQueuedSyncs[0].sync.token;
		const options = userPkQueuedSyncs[0].sync.syncOptions;
	
		// Perform the sync of new members
		await syncMembersNotInPk(options, token, uid, spMembers);
	}

	// Scenarios to handle
	// 	- Adding a user directly to front - DONE
	//  - Adding a front to front history - DONE
	//  - Changing a fronting member's front start time - DONE
	//  - Removing a user from front - DONE
	//  - Changing a past front history entry - DONE
	//  - Deleting a past front history entry - DONE

	console.log('HANDLE INSERT SYNCS');

	/* --- HANDLE INSERT SYNCS --- */
	const insertSyncs = userPkQueuedSyncs.filter((queuedSync) => queuedSync.sync.type === PkSyncType.Insert);

	// Loop through insert syncs and combine switches with the same start time and end time
	const batchedInsertSyncs: PkQueuedSync[][] = insertSyncs.reduce((accum, sync) => {
		const syncFrontingDoc = sync.sync.data.newFrontingDoc;

		if (!accum.length) {
			accum.push([sync]);
		} else {
			accum.forEach((arrayOfSyncs) => {
				arrayOfSyncs.forEach((accumSync) => {
					const frontingDoc = accumSync.sync.data.newFrontingDoc;
	
					if (syncFrontingDoc &&
						frontingDoc &&
						((syncFrontingDoc.live && frontingDoc.live && syncFrontingDoc.startTime === frontingDoc.startTime) ||
						(!syncFrontingDoc.live && !frontingDoc.live && syncFrontingDoc.startTime === frontingDoc.startTime && syncFrontingDoc.endTime === frontingDoc.endTime))) {
						arrayOfSyncs.push(sync);
					} else {
						accum.push([sync])
					}
				})
			});
		}

		return accum;
	}, [] as PkQueuedSync[][]);

	console.log('batchedInsertSyncs', batchedInsertSyncs);

	// Insert new switches for each set of batched insert syncs
	await Promise.all(batchedInsertSyncs.map(async (syncArray) => {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const frontingDocs = syncArray.map((sync) => sync.sync.data.newFrontingDoc!);

		const firstFrontingDoc = syncArray[0].sync.data.newFrontingDoc || syncArray[0].sync.data.oldFrontingDoc;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const live = firstFrontingDoc!.live;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const frontStartTime = firstFrontingDoc!.startTime;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const frontEndTime = live ? undefined : firstFrontingDoc!.endTime;

		const token = syncArray[0].sync.token;

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		await syncNewSwitchToPk(token, uid, frontingDocs, live ?? false, frontStartTime, frontEndTime!);

		return removeMultipleQueuedSyncs(uid, syncArray.map((sync) => sync.sync));
	}));

	console.log('HANDLE UPDATE SYNCS');

	/* --- HANDLE UPDATE SYNCS --- */
	const updateSyncs = userPkQueuedSyncs.filter((queuedSync) => queuedSync.sync.type === PkSyncType.Update);

	// Update switches
	await Promise.all(updateSyncs.map(async (sync) => {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		await syncUpdatedSwitchToPk(sync.sync.token, uid, sync.sync.data.live, sync.sync.data.oldFrontingDoc!, sync.sync.data.newFrontingDoc!);

		return removeQueuedSync(sync.sync);
	}));

	console.log('HANDLE DELETE SYNCS');

	/* --- HANDLE DELETE SYNCS --- */
	const deleteSyncs = userPkQueuedSyncs.filter((queuedSync) => queuedSync.sync.type === PkSyncType.Delete);

	// Delete switches
	await Promise.all(deleteSyncs.map(async (sync) => {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		syncDeletedSwitchToPk(sync.sync.token, uid, sync.sync.data.live, sync.sync.data.oldFrontingDoc!);

		return removeQueuedSync(sync.sync);
	}));
}

export const frontChangeToPk = async (uid: string, token: string, syncOptions: syncOptions, live: boolean, frontingDocId: string, oldFrontingDoc: SPFrontHistoryEntry | null, newFrontingDoc: SPFrontHistoryEntry | null, frontingDocChanged = false, frontingDocRemoved = false) => {
	// Enqueue an event for front sync for this user. The event controller will wait for 10 seconds without any front changes to perform the sync
	performEvent('frontSyncToPk', uid, 10 * 1000);

	// Determine the type of the pk sync
	const type = frontingDocRemoved ? PkSyncType.Delete : frontingDocChanged ? PkSyncType.Update : PkSyncType.Insert;

	// Set applicable data for the pk sync
	const data = {
		live,
		frontingDocId,
		oldFrontingDoc,
		newFrontingDoc,
	};

	// Add the pending sync to the pk sync controller
	addPendingSync({
		_id: new ObjectId(),
		uid,
		token,
		syncOptions,
		type,
		data
	})
}

export const frontChange = async (uid: string, removed: boolean, memberId: string, notifyReminders: boolean) => {

	if (notifyReminders === true)
	{
		notifyOfFrontChange(uid, removed, memberId)
	}

	const sharedCollection = getCollection("sharedFront");
	const privateCollection = getCollection("privateFront");
	const frontersCollection = getCollection("frontHistory");
	let sharedData = await sharedCollection.findOne({ uid: uid, _id: uid });
	let privateData = await privateCollection.findOne({ uid: uid, _id: uid });
	const frontersData = await frontersCollection.find({ uid: uid, live: true }).toArray();

	// Can be null if the user is new :)
	if (!sharedData) {
		sharedData = {};
	}

	if (!privateData) {
		privateData = {};
	}

	const members = getCollection("members");
	const frontStatuses = getCollection("frontStatuses");

	const fronterNames: Array<string> = [];
	const fronterNotificationNames: Array<string> = [];
	const customFronterNames: Array<string> = [];

	const privateFronterNames: Array<string> = [];
	const privateFronterNotificationNames: Array<string> = [];
	const privateCustomFronterNames: Array<string> = [];

	for (let i = 0; i < frontersData.length; ++i) {
		const fronter = frontersData[i];
		if (fronter.custom) {
			const doc = await frontStatuses.findOne({ uid: uid, _id: parseId(fronter.member) });
			if (doc !== null) {
				if (doc.private !== undefined && doc.private !== null && !doc.private) {
					customFronterNames.push(doc.name);
					privateCustomFronterNames.push(doc.name);
				} else if (doc.preventTrusted !== true) {
					privateCustomFronterNames.push(doc.name);
				}
			}
		} else {
			const doc = await members.findOne({ uid: uid, _id: parseId(fronter.member) });
			if (doc !== null) {
				if (doc.private !== undefined && doc.private !== null && doc.private === false) {
					if (doc.preventsFrontNotifs !== true) {
						fronterNotificationNames.push(doc.name);
						privateFronterNotificationNames.push(doc.name);
					}
					fronterNames.push(doc.name);
					privateFronterNames.push(doc.name);

				} else if (doc.preventTrusted !== true) {
					if (doc.preventsFrontNotifs !== true) {
						privateFronterNotificationNames.push(doc.name);
					}
					privateFronterNames.push(doc.name);
				}
			} else {
				logger.warn("cannot find " + fronter);
			}
		}
	}

	customFronterNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	fronterNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	fronterNotificationNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	privateCustomFronterNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	privateFronterNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	privateFronterNotificationNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	const getFronterString = (entries: Array<string>) => {
		const value = entries.join(", ");
		return value;
	};

	sharedCollection.updateOne(
		{ uid: uid, _id: uid },
		{
			$set: {
				fronters: fronterNames,
				customFronters: customFronterNames,
				frontString: getFronterString(fronterNames),
				customFrontString: getFronterString(customFronterNames),
				frontNotificationString: getFronterString(fronterNotificationNames),
			},
		},
		{ upsert: true }
	);

	privateCollection.updateOne(
		{ uid: uid, _id: uid },
		{
			$set: {
				fronters: privateFronterNames,
				customFronters: privateCustomFronterNames,
				frontString: getFronterString(privateFronterNames),
				customFrontString: getFronterString(privateCustomFronterNames),
				frontNotificationString: getFronterString(privateFronterNotificationNames),
				private: true,
			},
		},
		{ upsert: true }
	);

	const beforeFrontString = sharedData.beforeFrontNotificationString;
	const beforeCustomFrontString = sharedData.beforeCustomFrontString;

	const frontNotificationString = getFronterString(fronterNotificationNames);
	const customFrontString = getFronterString(customFronterNames);

	const friendCollection = getCollection("friends");
	const foundFriends = await friendCollection.find({ uid: uid }).toArray();

	if (beforeFrontString !== frontNotificationString || beforeCustomFrontString !== customFrontString) {
		performEvent("frontChangeShared", uid, 10 * 1000);
		sharedCollection
			.updateOne(
				{ uid: uid, _id: uid },
				{ $set: { beforeFrontNotificationString: frontNotificationString, beforeCustomFrontString: customFrontString } },
				{ upsert: true }
			)
			.catch(logger.error);
	}

	const privateBeforeFrontString = privateData.beforeFrontNotificationString;
	const privateBeforeCustomFrontString = privateData.beforeCustomFrontString;

	const privateFrontNotificationString = getFronterString(privateFronterNotificationNames);
	const priavteCustomFrontString = getFronterString(privateCustomFronterNames);

	if (privateBeforeFrontString !== privateFrontNotificationString || privateBeforeCustomFrontString !== priavteCustomFrontString) {
		performEvent("frontChangePrivate", uid, 10 * 1000);
		privateCollection
			.updateOne(
				{ uid: uid, _id: uid },
				{ $set: { beforeFrontNotificationString: frontNotificationString, beforeCustomFrontString: customFrontString } },
				{ upsert: true }
			)
			.catch(logger.error);

	}

	if (foundFriends.length <= 0) {
		return;
	}
};

export const notifySharedFrontDue = async (uid: string, _event: any) => {
	const sharedCollection = getCollection("sharedFront");
	const sharedData = await sharedCollection.findOne({ uid: uid, _id: uid });
	notifyFront(sharedData.frontNotificationString, sharedData.customFrontString, uid, false);
}

export const notifyPrivateFrontDue = async (uid: string, _event: any) => {
	const privateCollection = getCollection("privateFront");
	const privateData = await privateCollection.findOne({ uid: uid, _id: uid });
	notifyFront(privateData.frontNotificationString, privateData.customFrontString, uid, true);
}

const notifyFront = async (
	frontNotificationString: string,
	customFrontString: string,
	uid: string,
	trusted: boolean
) => {
	let message = "";

	if (frontNotificationString.length > 0) {
		if (customFrontString.length > 0) {
			message = "Fronting: " + frontNotificationString + " \n" + "Custom fronting: " + customFrontString;
		} else {
			message = "Fronting: " + frontNotificationString;
		}
	} else if (customFrontString.length > 0) {
		message = "Custom fronting: " + customFrontString;
	}

	// no public members to show as front.
	if (message.length <= 0) {
		return;
	}

	const userDoc = await getCollection("users").findOne({ uid: uid });

	const trustedQuery: any[] = [];
	if (trusted === false) {
		trustedQuery.push({ "trusted": false });
		trustedQuery.push({ "trusted": null });
	}
	else {
		trustedQuery.push({ "trusted": true });
	}

	const friendCollection = getCollection("friends")
	const foundFriends = await friendCollection.find({ uid: uid }).toArray();
	foundFriends.forEach(async (doc) => {
		const getFrontNotif = doc["getFrontNotif"];

		if (getFrontNotif) {
			const selfFriendSettings = await friendCollection.findOne({ frienduid: doc["frienduid"], uid: uid, $or: trustedQuery });
			const friendSettings = await friendCollection.findOne({ frienduid: uid, uid: doc["frienduid"] });
			if (friendSettings && selfFriendSettings && friendSettings["getTheirFrontNotif"]) {
				notifyUser(doc["frienduid"], userDoc["username"], message);
			}
		}
	});
};
