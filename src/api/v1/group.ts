import { Request, Response } from "express";
import { getCollection, parseId } from "../../modules/mongo";
import { dispatchDelete, OperationType } from "../../modules/socket";
import { fetchSimpleDocument, addSimpleDocument, updateSimpleDocument, fetchCollection } from "../../util";
import { getPrivacyDependency, validateSchema } from "../../util/validation";

export const getGroups = async (req: Request, res: Response) => {
	fetchCollection(req, res, "groups", {});
}

export const get = async (req: Request, res: Response) => {
	fetchSimpleDocument(req, res, "groups");
}

export const add = async (req: Request, res: Response) => {
	addSimpleDocument(req, res, "groups");
}

export const update = async (req: Request, res: Response) => {
	const group = await getCollection("groups").findOne({ uid: res.locals.uid, _id: parseId(req.params.id) })

	if (req.body.private === true && req.body.preventTrusted !== null && req.body.preventTrusted !== null) {
		if (group.private !== req.body.private || req.body.preventTrusted != group.preventTrusted) {
			privateGroupRecursive(req.params.id, res.locals.uid, req.body.private, req.body.preventTrusted)
		}
	}

	updateSimpleDocument(req, res, "groups")
}

export const del = async (req: Request, res: Response) => {
	await delGroupRecursive(req.params.id, res.locals.uid)
	res.status(200).send()
}

const delGroupRecursive = async (groupId: string, uid: string) => {
	const groups = await getCollection("groups").find({ uid, parent: groupId }).toArray()
	for (let i = 0; i < groups.length; i++) {
		await delGroupRecursive(groups[i]._id.toString(), uid)
	}
	await getCollection("groups").deleteOne({ uid, _id: parseId(groupId) })
	dispatchDelete({
		operationType: OperationType.Delete,
		uid,
		documentId: groupId,
		collection: "groups"
	})
}

const privateGroupRecursive = async (groupId: string, uid: string, priv: boolean, preventTrusted: boolean) => {
	const groups = await getCollection("groups").find({ uid, parent: groupId }).toArray()
	for (let i = 0; i < groups.length; i++) {
		await privateGroupRecursive(groups[i]._id.toString(), uid, priv, preventTrusted)
	}

	await getCollection("groups").updateOne({ uid, _id: parseId(groupId) }, { $set: { "private": priv, preventTrusted } })
}

export const validateGroupSchema = (body: any): { success: boolean, msg: string } => {
	const schema = {
		type: "object",
		properties: {
			parent: { type: "string" },
			color: { type: "string" },
			private: { type: "boolean" },
			preventTrusted: { type: "boolean" },
			name: { type: "string" },
			desc: { type: "string" },
			emoji: { type: "string" },
			members: { type: "array", items: { type: "string" } },
			supportDescMarkdown: { type: "boolean" },
		},
		nullable: false,
		additionalProperties: false,
		dependencies: getPrivacyDependency()
	};

	return validateSchema(schema, body);
}

export const validatePostGroupSchema = (body: any): { success: boolean, msg: string } => {
	const schema = {
		type: "object",
		properties: {
			parent: { type: "string" },
			color: { type: "string" },
			private: { type: "boolean" },
			preventTrusted: { type: "boolean" },
			name: { type: "string" },
			desc: { type: "string" },
			emoji: { type: "string" },
			members: { type: "array", items: { type: "string" } },
			supportDescMarkdown: { type: "boolean" },
		},
		required: ["parent", "color", "private", "preventTrusted", "name", "desc", "emoji", "members"],
		nullable: false,
		additionalProperties: false,
		dependencies: getPrivacyDependency()
	};

	return validateSchema(schema, body);
}