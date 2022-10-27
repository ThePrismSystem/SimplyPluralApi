import { AnyBulkWriteOperation } from "mongodb";
import { getCollection, parseId } from "../../mongo"
import { dispatchCustomEvent } from "../../socket";
import { PkAPI, PkAPIError } from "./api";
import moment from "moment";
import validUrl from "valid-url";
import { PkInsertMember, PkMember, PkUpdateMember } from "./types";
import { SPFrontHistoryEntry } from "./syncController";
export interface syncOptions {
	name: boolean,
	avatar: boolean,
	pronouns: boolean,
	description: boolean,
	useDisplayName: boolean,
	color: boolean
}

export interface syncAllOptions {
	overwrite: boolean,
	add: boolean,
	privateByDefault: boolean
}

// Simply Plural colors are supported in a wide variety.
// We officially support: #ffffff, ffffff, #ffffffff
const spColorToPkColor = (color: string | undefined): string | undefined => {
	let pkColor = "";

	if (color) {
		if (color.length === 7) {
			pkColor = color.substring(1, 7);
		} else if (color.length === 9) {
			pkColor = color.substring(1, 7);
		} else if (color.length === 6) {
			pkColor = color;
		}

		if (RegExp(/^([a-fA-F0-9]{6})$/).test(pkColor)) {
			return pkColor;
		}

		return pkColor;
	}

	return undefined;
}

const limitStringLength = (value: string | undefined, length: number) => {

	let newValue = null;
	if (value != null && value != undefined) {
		if (value.length > length) {
			newValue = value.substring(0, length)
		}
		else {
			newValue = value;
		}
	}
	return newValue;
}

const handlePkAPIError = (e: any) => { 	
	if (e instanceof PkAPIError) {
		if (e.status === 401) {
			return { success: false, msg: `Failed to sync. PluralKit token is invalid.` }
		} else if (e.status === 403) {
			return { success: false, msg: `Failed to sync. You do not have access to this member.` }
		} else if (e.status === 502 || e.status === 503 || e.status === 504) {
			return { success: false, msg: `Failed to sync. We're unable to reach PluralKit.` }
		} else {
			return { success: false, msg: `${e.status?.toString() ?? ""}` }
		}
	} else {
		return { success: false, msg: `Unable to reach PluralKit's servers` };
	}
}

export const syncMemberToPk = async (options: syncOptions, spMemberId: string, token: string, userId: string, memberData: PkMember | undefined, knownSystemId: string | undefined): Promise<{ success: boolean, msg: string }> => {
	const spMemberResult = await getCollection("members").findOne({ uid: userId, _id: parseId(spMemberId) })

	let { name, avatarUrl, pronouns, desc } = spMemberResult;
	const { color } = spMemberResult;

	name = limitStringLength(name, 100)
	avatarUrl = limitStringLength(avatarUrl, 256)
	pronouns = limitStringLength(pronouns, 100)
	desc = limitStringLength(desc, 1000)

	const memberDataToSync: PkUpdateMember | PkInsertMember = {}
	if (options.name) {
		if (options.useDisplayName) {
			memberDataToSync.display_name = name;
		} else {
			memberDataToSync.name = name;
		}
	}

	if (options.avatar && avatarUrl) memberDataToSync.avatar_url = avatarUrl;
	if (options.pronouns && pronouns) memberDataToSync.pronouns = pronouns;
	if (options.description && desc != null) memberDataToSync.description = desc;
	if (options.color && color) {
		const updateColor = spColorToPkColor(color)
		if (updateColor) {
			memberDataToSync.color = updateColor;
		}
	}

	if (memberDataToSync.avatar_url)
	{
		if (!validUrl.isUri(memberDataToSync.avatar_url)) {
			delete memberDataToSync["avatar_url"]
		}
	}

	const pkAPI = new PkAPI(token, 'Member');

	if (spMemberResult) {
		const pkId: string | undefined | null = spMemberResult.pkId;

		if (pkId && pkId.length === 5) {
			let pkMemberResult = memberData;
			let status = memberData ? 200 : undefined;

			if (pkMemberResult === undefined) {
				try {
					pkMemberResult = await pkAPI.getMember(spMemberResult.pkId);
				} catch (e) {
					if (e instanceof PkAPIError) {
						if ([404, 403].includes(e.status)) {
							status = e.status;
						} else {
							return handlePkAPIError(e);
						}
					} else {
						return handlePkAPIError(e);
					}
				}
			}

			if (pkMemberResult) {
				const getResultSystemId = pkMemberResult.system ?? undefined;
				const memberSystemId = memberData ? knownSystemId : getResultSystemId
				if (status == 200 && (knownSystemId && memberSystemId != knownSystemId)) 
				{
					status = 404;
				}

				if (status == 200) {
					try {
						await pkAPI.updateMember(spMemberResult.pkId, memberDataToSync);

						return { success: true, msg: `${name} updated on PluralKit` };
					} catch (e) {
						return handlePkAPIError(e);
					}
				}
				else if (status === 404 || status === 403) {
					memberDataToSync.name = name;

					try {
						const insertedMember = await pkAPI.insertMember(memberDataToSync as PkInsertMember);

						await getCollection("members").updateOne({ uid: userId, _id: parseId(spMemberId) }, { $set: { pkId: insertedMember.id } });
						
						return { success: true, msg: `${name} added to PluralKit` };
					} catch (e) {
						return handlePkAPIError(e);
					}
				}
			}
		}
		else {
			memberDataToSync.name = name;

			try {
				const insertedMember = await pkAPI.insertMember(memberDataToSync as PkInsertMember);

				await getCollection("members").updateOne({ uid: userId, _id: parseId(spMemberId) }, { $set: { pkId: insertedMember.id } });
						
				return { success: true, msg: `${name} added to PluralKit` };
			} catch (e) {
				return handlePkAPIError(e);
			}
		}
	}

	return { success: false, msg: "Member does not exist in Simply Plural for this account." }
}

export const syncMemberFromPk = async (options: syncOptions, pkMemberId: string, token: string, userId: string, memberData: any | undefined, batch: AnyBulkWriteOperation<any>[] | undefined, privateByDefault: boolean): Promise<{ success: boolean, msg: string }> => {

	let data: any | undefined = memberData;

	const pkAPI = new PkAPI(token, 'Member');

	if (!memberData) {
		try {
			data = await pkAPI.getMember(pkMemberId);
		} catch (e) {
			return handlePkAPIError(e);
		}
	}

	const spMemberResult = await getCollection("members").findOne({ uid: userId, pkId: pkMemberId })
	const forceSyncProperties = spMemberResult == null;
	const memberDataToSync: any = {}
	if (options.name || forceSyncProperties) {
		if (options.useDisplayName && data.display_name) {
			memberDataToSync.name = data.display_name;
		} else {
			memberDataToSync.name = data.name;
		}
	}

	if ((options.avatar || forceSyncProperties) && data.avatar_url) memberDataToSync.avatarUrl = data.avatar_url;
	if ((options.pronouns || forceSyncProperties) && data.pronouns) memberDataToSync.pronouns = data.pronouns;
	if ((options.description || forceSyncProperties) && data.description) memberDataToSync.desc = data.description;
	if ((options.color || forceSyncProperties) && data.color) memberDataToSync.color = data.color;

	if (spMemberResult) {
		if (memberDataToSync && Object.keys(memberDataToSync).length > 0) {
			{
				if (batch) {
					batch.push({ updateOne: { update: { $set: memberDataToSync }, filter: { uid: userId, pkId: pkMemberId } }, })
				}
				else {
					await getCollection("members").updateOne({ uid: userId, pkId: pkMemberId }, { $set: memberDataToSync }, {})
				}
			}
		}
		return { success: true, msg: `${spMemberResult.name ?? ""} updated on Simply Plural` }
	}
	else {
		memberDataToSync.uid = userId;
		memberDataToSync.pkId = pkMemberId;

		if (memberData.privacy?.visibility === "private" || privateByDefault) {
			memberDataToSync.private = true;
			memberDataToSync.preventTrusted = true;
		}
		else {
			memberDataToSync.private = false;
			memberDataToSync.preventTrusted = false;
		}

		memberDataToSync.preventsFrontNotifs = false;

		if (batch) {
			batch.push({ insertOne: { document: memberDataToSync } })
		}
		else {
			await getCollection("members").insertOne(memberDataToSync)
		}

		return { success: true, msg: `${memberData.name} added to Simply Plural` }
	}
}

export const syncAllSpMembersToPk = async (options: syncOptions, _allSyncOptions: syncAllOptions, token: string, userId: string): Promise<{ success: boolean, msg: string }> => {
	const spMembersResult = await getCollection("members").find({ uid: userId }).toArray()

	dispatchCustomEvent({uid: userId, type: "syncToUpdate", data: "Starting Sync"})

	const pkAPI = new PkAPI(token, 'Member');

	try {
		await pkAPI.setSystemId();
	} catch (e) {
		return handlePkAPIError(e);
	}

	let foundMembers: PkMember[] = [];

	try {
		foundMembers = await pkAPI.getMembers();
	} catch (e) {
		return handlePkAPIError(e);
	}

	let lastUpdate = 0;

	for (let i = 0; i < spMembersResult.length; ++i) {
		const member = spMembersResult[i];

		const currentCount = i + 1;

		if (moment.now() > lastUpdate + 1000)
		{
			dispatchCustomEvent({uid: userId, type: "syncToUpdate", data: `Syncing ${member.name}, ${currentCount.toString()} out of ${spMembersResult.length.toString()}`})
			lastUpdate = moment.now()
		}      
		
		const foundMember : PkMember | undefined = foundMembers.find((value) => value.id === member.pkId)

		await syncMemberToPk(options, member._id, token, userId, foundMember, pkAPI.systemId || undefined);
	}
	return { success: true, msg: "Sync completed" }
}

export const syncAllPkMembersToSp = async (options: syncOptions, allSyncOptions: syncAllOptions, token: string, userId: string): Promise<{ success: boolean, msg: string }> => {
	dispatchCustomEvent({uid: userId, type: "syncFromUpdate", data: "Starting Sync"});

	const pkAPI = new PkAPI(token, 'Member');

	let foundMembers: PkMember[] = [];

	try {
		foundMembers = await pkAPI.getMembers();
	} catch (e) {
		return handlePkAPIError(e);
	}
	
	let lastUpdate = 0;

	const promises: Promise<{ success: boolean, msg: string }>[] = [];

	const bulkWrites: AnyBulkWriteOperation<any>[] = []

	for (let i = 0; i < foundMembers.length; ++i) {
		const member = foundMembers[i];
		const currentCount = i + 1;

		if (moment.now() > lastUpdate + 1000)
		{
			dispatchCustomEvent({uid: userId, type: "syncFromUpdate", data: `Syncing ${member.name}, ${currentCount.toString()} out of ${foundMembers.length.toString()}`})
			lastUpdate = moment.now()
		}               

		const spMemberResult = await getCollection("members").findOne({ uid: userId, pkId: parseId(member.id) })
		if (spMemberResult && allSyncOptions.overwrite) {
			promises.push(syncMemberFromPk(options, member.id, token, userId, foundMembers[i], bulkWrites, allSyncOptions.privateByDefault));
		}

		if (!spMemberResult && allSyncOptions.add) {
			promises.push(syncMemberFromPk(options, member.id, token, userId, foundMembers[i], bulkWrites, allSyncOptions.privateByDefault));
		}
	}

	await Promise.all(promises);

	if (bulkWrites && bulkWrites.length > 0) {
		getCollection("members").bulkWrite(bulkWrites);
	}

	return { success: true, msg: "" }
}

export const syncMembersNotInPk = async (options: syncOptions, token: string, uid: string, spMembers: any[]) => {
	const pkAPI = new PkAPI(token, 'Member');

	const pkMembers = await pkAPI.getMembers();

	// Check if we need to insert any new members within this switch into pk
	const spMembersToSync = spMembers.filter((member) => !pkMembers.map((pkMember) => pkMember.id).includes(member.pkId));

	if (spMembersToSync.length) {
		// Insert new members into pk
		let lastUpdate = 0

		for (let i = 0; i < spMembersToSync.length; ++i) {
			const member = spMembersToSync[i];

			const currentCount = i + 1;

			if (moment.now() > lastUpdate + 1000)
			{
				dispatchCustomEvent({uid, type: "syncToUpdate", data: `Syncing ${member.name}, ${currentCount.toString()} out of ${spMembersToSync.length.toString()}`})
				lastUpdate = moment.now()
			}

			// Sync sp member to pk
			await syncMemberToPk(options, member._id, token, uid, undefined, pkAPI.systemId || undefined);
		}
	}
}

export const syncNewSwitchToPk = async (token: string, uid: string, frontingDocIds: string[], live: boolean, frontStartTime: number, frontEndTime?: number): Promise<void> => {
	// Get applicable fronting docs
	const frontHistoryDocs: SPFrontHistoryEntry[] = await getCollection('frontHistory').find({ uid, _id: { '$in': frontingDocIds.map((docId) => parseId(docId))}}).toArray();

	// Get members for applicable fronting docs
	const frontHistoryMembers: any[] = await getCollection('members').find({ uid, _id: { '$in': frontHistoryDocs.map((doc) => parseId(doc.member)) }}).toArray();

	const pkAPI = new PkAPI(token, 'FrontSync');

	const frontHistoryMemberPkIds = frontHistoryMembers.map((member) => member.pkId);

	// Check if a switch already exists at the exact start time of this new switch
	const switchAtExactStartTime = await pkAPI.getSwitchAtExactTimestamp(frontStartTime);

	if (switchAtExactStartTime !== null) {
		// A switch exists already at the start time, so change members of the existing switch

		// Combine and de-duplicate the old members list with the new one
		const newMembersArray = [...new Set([...switchAtExactStartTime.members, ...frontHistoryMemberPkIds])];

		await pkAPI.updateSwitchMembers(switchAtExactStartTime.id, newMembersArray);
	} else {
		// No switch exists at the start time, so create a new one
		await pkAPI.insertSwitch(frontStartTime, frontHistoryMemberPkIds);
	}

	if (live) {
		// Get all switches between the front start time and now
		const applicableSwitches = await pkAPI.getSwitchesBetweenTwoTimestamps(frontStartTime, +new Date());

		// Add member(s) to the found switches
		await pkAPI.addMembersToMultipleSwitches(frontHistoryMembers.map((member) => member.pkId), applicableSwitches);
	} else {
		if (frontEndTime) {
			// Get the switch (if it exists) at the exact front end time
			const switchAtExactEndTime = await pkAPI.getSwitchAtExactTimestamp(frontEndTime);

			if (switchAtExactEndTime) {
				// Update the switch at the exact front end time to not include the member(s) in the switch being inserted
				const endTimeSwitchMembers = switchAtExactEndTime.members.filter((member) => !frontHistoryMemberPkIds.includes(member));

				await pkAPI.updateSwitchMembers(switchAtExactEndTime.id, endTimeSwitchMembers);
			} else {
				// Get the switch closest to the front end time (that is less than the end time)
				const closestSwitchToEndTime = await pkAPI.getSwitches(frontEndTime + 1, 1);

				const endTimeSwitchMembers = closestSwitchToEndTime[0].members.filter((member) => !frontHistoryMemberPkIds.includes(member));

				// Insert a new switch at the front end time with the members of the previous switch (minus the members in the switch being inserted)
				await pkAPI.insertSwitch(frontEndTime, endTimeSwitchMembers);
			}
		}
	}
}

export const syncUpdatedSwitchToPk = async (token: string, uid: string, frontingDocId: string, live: boolean, oldFrontHistoryDoc: SPFrontHistoryEntry): Promise<void> => {
	// Get new fronting doc
	const newFrontHistoryDoc: SPFrontHistoryEntry = await getCollection('frontHistory').findOne({ uid, _id: parseId(frontingDocId)});

	// Get new fronting doc member
	const newFrontHistoryMember: any = await getCollection('members').findOne({ uid, _id: parseId(newFrontHistoryDoc.member)});

	// Get old fronting doc member
	const oldFrontingDocMember: any = await getCollection('members').findOne({ uid, _id: parseId(oldFrontHistoryDoc.member)});

	const pkAPI = new PkAPI(token, 'FrontSync');

	if (live) {
		// Get all switches between the earliest front start time (of both old and new fronts) and now
		const allApplicableSwitches = await pkAPI.getSwitchesBetweenTwoTimestamps(Math.min(oldFrontHistoryDoc.startTime, newFrontHistoryDoc.startTime), +new Date());

		if (oldFrontHistoryDoc.member !== newFrontHistoryDoc.member) {
			const switchesToReplaceMemberIn = allApplicableSwitches.filter((switchObj) => new Date(switchObj.timestamp).getTime() >= oldFrontHistoryDoc.startTime);

			await pkAPI.replaceMemberInMultipleSwitches(oldFrontingDocMember.pkId, newFrontHistoryMember.pkId, switchesToReplaceMemberIn);
		}

		if (oldFrontHistoryDoc.startTime !== newFrontHistoryDoc.startTime) {
			// Get switches that the member should be removed from and remove from those switches
			const switchesToRemoveMemberFrom = allApplicableSwitches.filter((switchObj) => new Date(switchObj.timestamp).getTime() < newFrontHistoryDoc.startTime);
			await pkAPI.removeMemberFromMultipleSwitches(newFrontHistoryMember.pkId, switchesToRemoveMemberFrom);

			// Check if a switch already exists at the exact start time of the updated switch
			const switchAtExactStartTime = await pkAPI.getSwitchAtExactTimestamp(newFrontHistoryDoc.startTime);

			if (switchAtExactStartTime !== null) {
				// A switch exists already at the start time, so change members of the existing switch

				// Combine and de-duplicate the old members list with the new one
				const newMembersArray = [...new Set(switchAtExactStartTime.members.concat(newFrontHistoryMember.pkId))];

				await pkAPI.updateSwitchMembers(switchAtExactStartTime.id, newMembersArray);
			} else {
				// No switch exists at the start time, so create a new one
				await pkAPI.insertSwitch(newFrontHistoryDoc.startTime, newFrontHistoryMember.pkId);
			}

			// Get switches that the member should be added to and add them to those switches
			const switchesToAddMemberTo = allApplicableSwitches.filter((switchObj) => new Date(switchObj.timestamp).getTime() > newFrontHistoryDoc.startTime);
			await pkAPI.addMemberToMultipleSwitches(newFrontHistoryMember.pkId, switchesToAddMemberTo);
		}
	} else {
		if (oldFrontHistoryDoc.endTime && newFrontHistoryDoc.endTime) {
			// Get all switches between the earliest front start time (of both old and new fronts) and the latest front end time (of both old and new fronts)
			const allApplicableSwitches = await pkAPI.getSwitchesBetweenTwoTimestamps(
				Math.min(oldFrontHistoryDoc.startTime, newFrontHistoryDoc.startTime),
				Math.max(oldFrontHistoryDoc.endTime, newFrontHistoryDoc.endTime));

			if (oldFrontHistoryDoc.member !== newFrontHistoryDoc.member) {
				const switchesToReplaceMemberIn = allApplicableSwitches.filter((switchObj) =>
					new Date(switchObj.timestamp).getTime() >= oldFrontHistoryDoc.startTime &&
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					new Date(switchObj.timestamp).getTime() <= oldFrontHistoryDoc.endTime!);

				await pkAPI.replaceMemberInMultipleSwitches(oldFrontingDocMember.pkId, newFrontHistoryMember.pkId, switchesToReplaceMemberIn);
			}

			if (oldFrontHistoryDoc.startTime !== newFrontHistoryDoc.startTime || oldFrontHistoryDoc.endTime !== newFrontHistoryDoc.endTime) {
				// Get switches that the member should be removed from and remove from those switches
				const switchesToRemoveMemberFrom = allApplicableSwitches.filter((switchObj) =>
					new Date(switchObj.timestamp).getTime() < newFrontHistoryDoc.startTime ||
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					new Date(switchObj.timestamp).getTime() > oldFrontHistoryDoc.endTime!);
				await pkAPI.removeMemberFromMultipleSwitches(newFrontHistoryMember.pkId, switchesToRemoveMemberFrom);

				// Check if a switch already exists at the exact start time of the updated switch
				const switchAtExactStartTime = await pkAPI.getSwitchAtExactTimestamp(newFrontHistoryDoc.startTime);

				if (switchAtExactStartTime !== null) {
				// A switch exists already at the start time, so change members of the existing switch

					// Combine and de-duplicate the old members list with the new one
					const newMembersArray = [...new Set(switchAtExactStartTime.members.concat(newFrontHistoryMember.pkId))];

					await pkAPI.updateSwitchMembers(switchAtExactStartTime.id, newMembersArray);
				} else {
				// No switch exists at the start time, so create a new one
					await pkAPI.insertSwitch(newFrontHistoryDoc.startTime, newFrontHistoryMember.pkId);
				}

				// Get the switch (if it exists) at the exact front end time
				const switchAtExactEndTime = await pkAPI.getSwitchAtExactTimestamp(newFrontHistoryDoc.endTime);

				if (switchAtExactEndTime) {
					// Update the switch at the exact front end time to not include the member in the switch being updated
					const endTimeSwitchMembers = switchAtExactEndTime.members.filter((member) => member !== newFrontHistoryMember.pkId);

					await pkAPI.updateSwitchMembers(switchAtExactEndTime.id, endTimeSwitchMembers);
				} else {
					// Get the switch closest to the front end time (that is less than the end time)
					const closestSwitchToEndTime = await pkAPI.getSwitches(newFrontHistoryDoc.endTime + 1, 1);

					const endTimeSwitchMembers = closestSwitchToEndTime[0].members.filter((member) => member !== newFrontHistoryMember.pkId);

					// Insert a new switch at the front end time with the members of the previous switch (minus the member in the switch being updated)
					await pkAPI.insertSwitch(newFrontHistoryDoc.endTime, endTimeSwitchMembers);
				}

				// Get switches that the member should be added to and add them to those switches
				const switchesToAddMemberTo = allApplicableSwitches.filter((switchObj) =>
					new Date(switchObj.timestamp).getTime() > newFrontHistoryDoc.startTime ||
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					new Date(switchObj.timestamp).getTime() < oldFrontHistoryDoc.endTime!);
				await pkAPI.addMemberToMultipleSwitches(newFrontHistoryMember.pkId, switchesToAddMemberTo);
			}
		}
	}
}

export const syncDeletedSwitchToPk = async (token: string, uid: string, live: boolean, oldFrontHistoryDoc: SPFrontHistoryEntry): Promise<void> => {
	// Get old fronting doc member
	const oldFrontingDocMember: any = await getCollection('members').findOne({ uid, _id: parseId(oldFrontHistoryDoc.member)});

	const pkAPI = new PkAPI(token, 'FrontSync');

	if (live) {
		// Get switches that the member should be removed from and remove from those switches
		const switchesToRemoveMemberFrom = await pkAPI.getSwitchesBetweenTwoTimestamps(oldFrontHistoryDoc.startTime, +new Date());
		await pkAPI.removeMemberFromMultipleSwitches(oldFrontingDocMember.pkId, switchesToRemoveMemberFrom);
	} else {
		// Get switches that the member should be removed from and remove from those switches
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const switchesToRemoveMemberFrom = await pkAPI.getSwitchesBetweenTwoTimestamps(oldFrontHistoryDoc.startTime, oldFrontHistoryDoc.endTime!);
		await pkAPI.removeMemberFromMultipleSwitches(oldFrontingDocMember.pkId, switchesToRemoveMemberFrom);
	}
}