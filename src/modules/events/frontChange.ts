import { notifyUser } from "../../util";
import { logger } from "../logger";
import { getCollection, parseId } from "../mongo";
import { notifyOfFrontChange } from "./automatedReminder";
import { performEvent } from "./eventController";
import { changePkSwitchTime, deletePkSwitch, replacePkSwitchMember, syncCurrentFrontersWithPk, syncOptions } from "../integrations/pk/sync";
import { addPendingSync, getAllQueuedSyncsForUser, PkSyncType, SPFrontHistoryEntry } from "../integrations/pk/syncController";
import { ObjectId } from "mongodb";

export const initiateFrontSyncToPk = async (uid: string, _event: any) => {
	// Get all applicable front sync events for the user
	const userPkQueuedSyncs = await getAllQueuedSyncsForUser(uid);

	// Scenarios to handle
	// 	- Adding a user directly to front
	//  - Changing a fronting member's front start time
	//  - Removing a user from front
	//  - Changing a past front history entry
	//  - Deleting a past front history entry

	// For inserting (non-live) - Check if switch exists at exact starttime. If it does, insert member to that switch, if not, insert a new switch. get all switches between starttime and endtime (inclusive) of the fronthistory entry and add member to those switches. check for switch at exact timestamp of endtime. If exists, make sure member doesn't exist in that switch, if does not exist, insert new switch with members of most recent switch before that switch without the new fronthistory entry member
	// For inserting (live) - Check if switch exists at exact starttime. If it does, insert member to that switch, if not, insert a new switch. get all switches between starttime and endtime (inclusive) of the fronthistory entry and add member to those switches.
	// For updating (live) - Get all switches between min starttime (between old and new fronthistory entry) and now. Remove member from applicable switches (along with inserting empty switches if needed), add member to applicable switches, and insert new switch at starttime if needed
	// For updating (non-live) - Get all switches between min starttime (between old and new fronthistory entry) and max endtime (between old and new fronthistory entry). Remove member from applicable switches (along with inserting empty switches if needed), add member to applicable switches, and insert new switch at starttime and/or endtime if needed
	// For deleting (live) - Get all pk switches between starttime and now (inclusive) of the deleted fronthistory entry. Remove member from those switches. If any switches only have that member, insert an empty switch from the previous switch with another member to the next switch with another member
	// For deleting (non-live) - Get all pk switches between starttime and endtime (inclusive) of the deleted fronthistory entry. Remove member from those switches. If any switches only have that member, insert an empty switch from the previous switch with another member to the next switch with another member

	// Handle insert syncs first
	const insertSyncs = userPkQueuedSyncs.filter((queuedSync) => queuedSync.sync.type === PkSyncType.Insert);

	// This array is used to track any fronting docs that are combined before switches are inserted into pk
	const insertFrontingDocIdsHandled = [];

	const insertSyncPromises = [];

	// Loop through insert syncs and perform logic to 
	insertSyncs.forEach((sync) => {

	});

	const includedInsertSync = userPkQueuedSyncs.find((queuedSync) => queuedSync.sync.type === PkSyncType.Insert);

	// If there is an included insert sync, we need to change current fronters in pk
	if (includedInsertSync) {
		const frontersCollection = getCollection("frontHistory");
		const frontersData = await frontersCollection.find({ uid: uid, live: true }).toArray();
	
		const members = getCollection("members");
	
		// Arrays to store the ids + data of current fronters for pk front syncing
		const fronterIds: Array<string> = [];
		const memberDocs: Array<any> = [];
	
		for (let i = 0; i < frontersData.length; ++i) {
			const fronter = frontersData[i];
			if (!fronter.custom) {
				const doc = await members.findOne({ uid: uid, _id: parseId(fronter.member) });
				if (doc !== null) {
					// Push data to array of fronter ids + data for pk front syncing
					fronterIds.push(doc._id);
					memberDocs.push(doc);
				} else {
					logger.warn("cannot find " + fronter);
				}
			}
		}
	
		// Sync current fronters with pk
		syncCurrentFrontersWithPk(uid, fronterIds, frontersData, new Date().toISOString(), token, syncOptions, frontingDocId);
	}
}

export const frontChangeToPk = async (uid: string, token: string, syncOptions: syncOptions, live: boolean, frontingDocId: string, oldFrontingDoc?: SPFrontHistoryEntry, frontingDocChanged = false, frontingDocRemoved = false) => {
	// Enqueue an event for front sync for this user. The event controller will wait for 10 seconds without any front changes to perform the sync
	performEvent('frontSyncToPk', uid, 10 * 1000);

	// Determine the type of the pk sync
	const type = frontingDocRemoved ? PkSyncType.Delete : frontingDocChanged ? PkSyncType.Update : PkSyncType.Insert;

	// Set applicable data for the pk sync
	const data = {
		live,
		frontingDocId,
		oldFrontingDoc,
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

export const initiateFrontChangeToPk = async (uid: string, token: string, syncOptions: syncOptions, frontingDocId?: any, oldFrontingDoc?: any, frontingDocChanged = false, frontingDocRemoved = false) => {
	if (frontingDocChanged) {
		const frontersCollection = getCollection("frontHistory");
		const newFrontingDoc = await frontersCollection.findOne({ _id: parseId(frontingDocId) });

		if (oldFrontingDoc.member !== newFrontingDoc.member) {
			const members = getCollection("members");

			const oldMemberDoc = await members.findOne({ uid: uid, _id: parseId(oldFrontingDoc.member) });
			const newMemberDoc = await members.findOne({ uid: uid, _id: parseId(newFrontingDoc.member) });

			if (oldMemberDoc.pkId) {
				await replacePkSwitchMember(newFrontingDoc.pkId, token, syncOptions, uid, oldMemberDoc, newMemberDoc, newMemberDoc.pkId === undefined);
			}
		}
		
		if (oldFrontingDoc.startTime !== newFrontingDoc.startTime) {
			changePkSwitchTime(oldFrontingDoc.pkId, token, newFrontingDoc.startTime);
		}
	} else if (frontingDocRemoved && oldFrontingDoc.pkId) {
		deletePkSwitch(oldFrontingDoc.pkId, token);
	} else {
		const frontersCollection = getCollection("frontHistory");
		const frontersData = await frontersCollection.find({ uid: uid, live: true }).toArray();
	
		const members = getCollection("members");
	
		// Arrays to store the ids + data of current fronters for pk front syncing
		const fronterIds: Array<string> = [];
		const memberDocs: Array<any> = [];
	
		for (let i = 0; i < frontersData.length; ++i) {
			const fronter = frontersData[i];
			if (!fronter.custom) {
				const doc = await members.findOne({ uid: uid, _id: parseId(fronter.member) });
				if (doc !== null) {
					// Push data to array of fronter ids + data for pk front syncing
					fronterIds.push(doc._id);
					memberDocs.push(doc);
				} else {
					logger.warn("cannot find " + fronter);
				}
			}
		}
	
		// Sync current fronters with pk
		syncCurrentFrontersWithPk(uid, fronterIds, frontersData, new Date().toISOString(), token, syncOptions, frontingDocId);
	}
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
