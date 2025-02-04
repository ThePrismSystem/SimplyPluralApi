import { Request, Response } from "express";
import moment from "moment";
import { min } from "moment";
import { frontChange } from "../../modules/events/frontChange";
import { getCollection, parseId } from "../../modules/mongo";
import { documentObject } from "../../modules/mongo/baseTypes";
import { fetchSimpleDocument, addSimpleDocument, updateSimpleDocument, sendDocuments, deleteSimpleDocument, fetchCollection, isMemberOrCustomFront, isCustomFront } from "../../util";
import { validateSchema } from "../../util/validation";

export const getFrontTimeRangeQuery = (req: Request, res: Response) => {
	return  { $and: [{ uid: res.locals.uid }, {
			$or: [
				{ $and: [ {endTime: { $gte: Number(req.query.endTime) } }, { startTime: { $lte: Number(req.query.startTime) }}, { endTime: { $gte: Number(req.query.startTime) }} ]},  // starts after start, ends after end, but doesn't start after end
				{ startTime: { $lte: Number(req.query.startTime) }, endTime: { $gte: Number(req.query.startTime) } }, //start before start, ends after start
				{ startTime: { $gte: Number(req.query.startTime) }, endTime: { $lte: Number(req.query.endTime) } }, // start after start, ends before end
				{ startTime: { $lte: Number(req.query.endTime) }, endTime: { $gte: Number(req.query.endTime) } } //Starts before end, ends after end
			]
		}]
	};
}

export const getFrontHistoryInRange = async (req: Request, res: Response) => {
	const query = getFrontTimeRangeQuery(req, res)
	const documents: documentObject[] = await getCollection("frontHistory").find(query).toArray()
	sendDocuments(req, res, "frontHistory", documents);
}

export const getFrontHistory = async (req: Request, res: Response) => {
	fetchCollection(req, res, "frontHistory", {});
}

export const getFrontHistoryForMember = async (req: Request, res: Response) => {
	fetchCollection(req, res, "frontHistory", { member: req.params.id });
}

export const getFronters = async (req: Request, res: Response) => {
	const documents: documentObject[] = await getCollection("frontHistory").find({ uid: res.locals.uid, live: true }).toArray()
	sendDocuments(req, res, "frontHistory", documents);
}

export const get = async (req: Request, res: Response) => {
	fetchSimpleDocument(req, res, "frontHistory");
}

export const add = async (req: Request, res: Response) => {
	if (req.body.live === true) {
		const potentiallyFrontingDoc = await getCollection("frontHistory").findOne({ uid: res.locals.uid, member: req.body.member, live: true })
		if (potentiallyFrontingDoc) {
			res.status(409).send("This member is already set to be fronting. Remove them from front prior to adding them to front")
			return
		}
	}

	const isValidMemberId = await isMemberOrCustomFront(res.locals.uid, req.body.member);
	if (!isValidMemberId) {
		res.status(404).send("This member does not exist for this account")
		return
	}

	req.body.startTime = Math.min(moment.now(), Number(req.body.startTime))
	req.body.endTime = Math.min(moment.now(), Number(req.body.endTime))

	// Start time cannot be larger than endTime
	if (req.body.startTime >= req.body.endTime)
	{
		req.body.startTime = req.body.endTime - 1;
	}

	await addSimpleDocument(req, res, "frontHistory");
	frontChange(res.locals.uid, false, req.body.member, true)
}

export const update = async (req: Request, res: Response) => {
	const frontingDoc = await getCollection("frontHistory").findOne({ _id: parseId(req.params.id) })
	if (frontingDoc) {
		if (frontingDoc.live === false && req.body.live === true) {
			res.status(409).send("You cannot update a front history entry to live, if you wish to add someone to front, use POST instead.")
			return
		}

		if (req.body.member != null && req.body.member != undefined && frontingDoc.live === true) {

			// Only allow changing of a member value to a valid member value
			if (req.body.member != frontingDoc.member) {
				const isValidMemberId = await isMemberOrCustomFront(res.locals.uid, req.body.member);
				if (!isValidMemberId) {
					res.status(404).send("This member does not exist for this account")
					return
				}
			}

			const alreadyFrontingDoc = await getCollection("frontHistory").findOne({ member: req.body.member, live: true })
			if (alreadyFrontingDoc && alreadyFrontingDoc._id != req.params.id) {
				res.status(409).send("You cannot change an active front entry to this member, they are already fronting")
				return
			}
		}

		if (req.body.startTime)
		{
			req.body.startTime = Math.min(moment.now(), Number(req.body.startTime))
		}

		if (req.body.endTime)
		{
			req.body.endTime = Math.min(moment.now(), Number(req.body.endTime))
		}

		await updateSimpleDocument(req, res, "frontHistory")

		const isCustom = await isCustomFront(res.locals.uid, req.body.member ?? frontingDoc.member);
		await getCollection("frontHistory").updateOne({ _id: parseId(req.params.id) }, { $set: { custom: isCustom } })

		if (frontingDoc.live === true && req.body.live === false) {
			frontChange(res.locals.uid, false, req.body.member ?? frontingDoc.member, true)
		}
	}
	else {
		res.status(404).send("Unable to find front document to remove")
	}
}

export const del = async (req: Request, res: Response) => {
	const frontingDoc = await getCollection("frontHistory").findOne({ _id: parseId(req.params.id) })

	// Delete all attached comments
	await getCollection("comments").deleteMany({ documentId: req.params.id, uid: res.locals.uid, collection: "frontHistory" });

	// If a fronting document is deleted, and it's a live one, notify front change
	if (frontingDoc) {
		if (frontingDoc.live === true) {
			frontChange(res.locals.uid, true, frontingDoc.member, true)
		}
	}

	deleteSimpleDocument(req, res, "frontHistory");
}

export const validatefrontHistoryPostSchema = (body: any): { success: boolean, msg: string } => {
	const schema = {
		type: "object",
		properties: {
			custom: { type: "boolean" },
			live: { type: "boolean" },
			startTime: { type: "number" },
			endTime: { type: "number" },
			member: { type: "string" },
			customStatus: { type: "string", maxLength: 50 }
		},
		nullable: false,
		additionalProperties: false,
		required: ["custom", "live", "startTime", "member"]
	};

	return validateSchema(schema, body);
}

export const validatefrontHistoryPatchSchema = (body: any): { success: boolean, msg: string } => {
	const schema = {
		type: "object",
		properties: {
			custom: { type: "boolean" },
			live: { type: "boolean" },
			startTime: { type: "number" },
			endTime: { type: "number" },
			member: { type: "string" },
			customStatus: { type: "string", maxLength: 50 }
		},
		nullable: false,
		additionalProperties: false
	};

	return validateSchema(schema, body);
}

// Query params so we have to use string pattern comparison
// Query proeprties are always strings
export const validateGetfrontHistorychema = (body: any): { success: boolean, msg: string } => {
	const schema = {
		type: "object",
		properties: {
			startTime: { type: "string", pattern: "^[0-9]" },
			endTime: { type: "string", pattern: "^[0-9]" },
		},
		nullable: false,
		required: ["startTime", "endTime"]
	};

	return validateSchema(schema, body);
}