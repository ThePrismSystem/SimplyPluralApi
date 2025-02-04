import { ObjectId } from "mongodb"
import { getCollection, parseId } from "../../../../modules/mongo"

export const update150 = async (uid: string) => {

	const fhCollection = getCollection("frontHistory")
	const memberCollection = getCollection("members")
	const frontHistoryForUser = await fhCollection.find({ uid }).toArray()
	const commentsToInsert = []
	for (let i = 0; i < frontHistoryForUser.length; ++i) {
		const entry = frontHistoryForUser[i]
		const comments: { time: { _seconds: number, _nanoseconds: number }, text: string }[] = entry.comments

		if (!comments)
			continue

		const _id: string | ObjectId = entry._id;
		const useId = _id.toString();

		for (let j = 0; j < comments.length; ++j) {
			const comment = comments[j]
			if (comment.time && comment.time._seconds) {
				// Convert seconds to milliseconds
				commentsToInsert.push({ uid, time: comments[j].time._seconds * 1000, text: comments[j].text, collection: "frontHistory", documentId: useId })
			}
			else {
				commentsToInsert.push({ uid, time: comments[j].time, text: comments[j].text, collection: "frontHistory", documentId: useId })
			}
		}

		fhCollection.updateOne({ _id: entry._id }, { $set: { commentCount: comments.length } });
	}

	if (commentsToInsert.length > 0)
		await getCollection("comments").insertMany(commentsToInsert)

	const fronters = await getCollection("fronters").find({ uid }).toArray()

	for (let i = 0; i < fronters.length; ++i) {
		const fronter = fronters[i]
		const foundMember = await memberCollection.findOne({ _id: parseId(fronter._id) })
		await fhCollection.insertOne({ uid, member: fronter._id, startTime: fronter.startTime, live: true, custom: !foundMember })
	}

	// Delete any front entries that are NOT live and have no endTime, these entries are old corrupted entries from back in March 2021.
	await fhCollection.deleteMany({ uid, live: { $ne: true }, endTime: null })

	const convertBinaryVotes = (votes: { id: string, comment: string, vote: string }[], toConvert: any[] | undefined, vote: string) => {
		if (toConvert) {
			for (let i = 0; i < toConvert.length; ++i) {
				const oldVote = toConvert[i];
				if (typeof oldVote === "string") {
					votes.push({ id: oldVote, vote: vote, comment: "" });
				}
				else {
					const oldVoteObj: { id: string, comment: string } = oldVote;
					votes.push({ id: oldVoteObj.id, vote: vote, comment: oldVoteObj.comment });
				}
			}
		}
	}

	const polls = await getCollection("polls").find({ uid }).toArray();
	for (let i = 0; i < polls.length; ++i) {
		const poll = polls[i]

		const yes = poll.yes
		const no = poll.no
		const abstain = poll.abstain
		const veto = poll.veto

		const votes: { id: string, comment: string, vote: string }[] = []

		convertBinaryVotes(votes, yes, "yes");
		convertBinaryVotes(votes, no, "no");
		convertBinaryVotes(votes, abstain, "abstain");
		convertBinaryVotes(votes, veto, "veto");

		const oldVotes: { [key: string]: { comment: string, vote: string } } | undefined = poll.votes

		if (oldVotes) {
			const oldKeys = Object.keys(oldVotes)
			for (let i = 0; i < oldKeys.length; ++i) {
				const key: string = oldKeys[i]
				const oldVote: { comment: string, vote: string } = oldVotes[key];
				const prop = key;
				votes.push({ id: prop, vote: oldVote.vote, comment: oldVote.comment });
			}
		}

		await getCollection("polls").updateOne({ _id: parseId(poll._id), uid }, { $set: { votes } });
	}

	// Update note version
	// Colors were previously an index matching a specific color, now they are color strings
	const notes = await getCollection("notes").find({ uid }).toArray();
	for (let i = 0; i < notes.length; ++i) {
		const note = notes[i]

		const color: number = note.color

		if (typeof color !== "string") {
			let colorString = "";
			switch (color) {
				case 0: colorString = "#000000"; break;
				case 1: colorString = "#c83232"; break;
				case 2: colorString = "#32c832"; break;
				case 3: colorString = "#3232c8"; break;
				case 4: colorString = "#eb0e58"; break;
				case 5: colorString = "#56dceb"; break;
				case 6: colorString = "#eb59da"; break;
				case 7: colorString = "#f25d3b"; break;
				default: "#ffffff";
			}
			await getCollection("notes").updateOne({ _id: parseId(note._id), uid }, { $set: { color: colorString } });
		}
	}

	// Fully deprecate old pk as sp ids,
	// Store pk id as document id if no valid pk id is stored in the member
	const members = await getCollection("members").find({ uid }).toArray();
	for (let i = 0; i < members.length; ++i) {
		const member = members[i]

		const pkId: string | undefined = member.pkId;
		const spId: string = member._id;

		if (spId.length == 5 && (!pkId || pkId.length != 5)) {
			await getCollection("members").updateOne({ _id: spId, uid }, { $set: { pkId: spId } });
		}
	}
}