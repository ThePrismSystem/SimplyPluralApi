import axios, { AxiosError, AxiosResponse } from "axios";
import { logger } from "../../logger";
import * as Sentry from "@sentry/node";
import { getCollection } from "../../mongo";
import promclient from "prom-client"
import { ObjectId } from "mongodb";

export enum PkRequestType {
	Get,
	Post,
	Patch,
	Delete
}

export interface PkRequest {
	_id?: ObjectId,
	path: string,
	token: string,
	data: any | undefined,
	type: PkRequestType,
	purpose: 'Member' | 'FrontSync',
	response: AxiosResponse<any> | null,
}

export interface QueuedRequest {
	_id: ObjectId,
	request: PkRequest,
	purpose: 'Member' | 'FrontSync',
}

let pendingRequestIds: ObjectId[] = [];
let pendingResponses: Array<PkRequest> = [];

const memberRateLimit = parseInt(process.env.MEMBERPLURALKITRATELIMIT ?? '2');
const frontSyncRateLimit = parseInt(process.env.FRONTSYNCPLURALKITRATELIMIT ?? '2');

let memberRemainingRequestsThisSecond = 0;
let frontSyncRemainingRequestsThisSecond = 0;

const memberPluralKitAppHeader = process.env.MEMBERPLURALKITAPP ?? '';
const frontSyncPluralKitAppHeader = process.env.FRONTSYNCPLURALKITAPP ?? '';

export const addPendingRequest = (request: PkRequest): Promise<AxiosResponse<any> | null> => {
	return new Promise(function (resolve) {

		request._id = new ObjectId();

		// Add as pending request
		const queuedRequests = getCollection(`pk${request.purpose}QueuedRequests`);
		queuedRequests.insertOne({ _id: request._id, request: request, purpose: request.purpose });

		// Wait until request was answered
		(function waitForAnswer() {
			const response = pendingResponses.find((response) => response._id?.toString() === request._id?.toString())

			if (response) {
				pendingResponses = pendingResponses.filter(response => response._id?.toString() != request._id?.toString())
				return resolve(response.response)
			}

			setTimeout(waitForAnswer, 50);
		})();
	});
}

export const startPkRequestController = () => {
	reportActiveQueueSize();
	tick()
	resetRequestCounter();
}

export const resetRequestCounter = () => {
	memberRemainingRequestsThisSecond = memberRateLimit;
	frontSyncRemainingRequestsThisSecond = frontSyncRateLimit;

	setTimeout(resetRequestCounter, 1000);
}

export const reportActiveQueueSize = async () => {
	const memberQueueSize = await getMemberQueueSize();
	const frontSyncQueueSize = await getFrontSyncQueueSize();

	console.log(`Active pk request controller (Member) queue size: ${memberQueueSize.toString()}`);
	console.log(`Active pk request controller (FrontSync) queue size: ${frontSyncQueueSize.toString()}`);

	setTimeout(reportActiveQueueSize, 10000);
}

const handleError = (reason: AxiosError) => {
	if (reason.response) {
		return reason.response;
	}
	return null;
}

export const getMemberQueueSize = () => getCollection(`pkMemberQueuedRequests`).countDocuments();

export const getFrontSyncQueueSize = () => getCollection(`pkFrontSyncQueuedRequests`).countDocuments();

export const tick = async () => {
	// Dispatch member requests
	try {
		const queuedMemberRequests = getCollection(`pkMemberQueuedRequests`);

		if (memberRemainingRequestsThisSecond > 0) {
			// Limit queued requests we're grabbing to ones not currently in the pendingRequestIds array - and - limit to the rate limit value for member requests
			const queuedRequestsToDispatch: QueuedRequest[] = await queuedMemberRequests.find({ _id: { "$nin": pendingRequestIds }}, { limit: memberRateLimit }).toArray();

			queuedRequestsToDispatch.forEach((queuedRequest) => {
				dispatchTickRequests(queuedRequest.request);
				// If we keep track of pending request IDs in-memory, we don't need to keep track of or filter based on a "started" property
				pendingRequestIds.push(queuedRequest._id);
				memberRemainingRequestsThisSecond--;
			});
		}
	}
	catch (e) {
		console.log(e);
		logger.error("Pk member sync error: " + e)
		Sentry.captureException(e);
	}

	// Dispatch front sync requests
	try {
		const queuedFrontSyncRequests = getCollection(`pkFrontSyncQueuedRequests`);

		if (frontSyncRemainingRequestsThisSecond > 0) {
			// Limit queued requests we're grabbing to ones not currently in the pendingRequestIds array - and - limit to the rate limit value for front sync requests
			const queuedRequestsToDispatch: QueuedRequest[] = await queuedFrontSyncRequests.find({ _id: { "$nin": pendingRequestIds }}, { limit: frontSyncRateLimit }).toArray();

			queuedRequestsToDispatch.forEach((queuedRequest) => {
				dispatchTickRequests(queuedRequest.request);
				// If we keep track of pending request IDs in-memory, we don't need to keep track of or filter based on a "request started" property
				pendingRequestIds.push(queuedRequest._id);
				frontSyncRemainingRequestsThisSecond--;
			});
		}
	}
	catch (e) {
		console.log(e);
		logger.error("Pk frontSync sync error: " + e)
		Sentry.captureException(e);
	}

	setTimeout(tick, 100)
}

export const removeQueuedRequest = async (request: PkRequest) => {
	// Remove request ID from the pending request IDs
	pendingRequestIds = pendingRequestIds.filter(requestId => requestId != requestId);
	
	// Remove the queued request document from mongo
	const queuedRequests = getCollection(`pk${request.purpose}QueuedRequests`);
	await queuedRequests.deleteOne({ _id: request._id });
}

const memberCounter  = new promclient.Counter({
	name: 'apparyllis_api_pk_member_syncs',
	help: 'Counter for member pk syncs performed',
	labelNames: ['method', 'statusCode'],
});

const frontSyncCounter  = new promclient.Counter({
	name: 'apparyllis_api_pk_frontsync_syncs',
	help: 'Counter for frontSync pk syncs performed',
	labelNames: ['method', 'statusCode'],
});
	
export const dispatchTickRequests = async (request: PkRequest) => {

	let debug = false;
	if (process.env.DEVELOPMENT) {
		debug = true
	}

	const type = request.type;
	switch (type) {
	case PkRequestType.Get: {
		if (debug)
		{
			console.log("GET=>"+ request.path)
		}
		const result = await axios.get(request.path, { headers: { authorization: request.token, "X-PluralKit-App": request.purpose === 'Member' ? memberPluralKitAppHeader : frontSyncPluralKitAppHeader } }).catch(handleError);
		(request.purpose === 'Member' ? memberCounter : frontSyncCounter).labels("GET", result?.status.toString() ?? "503").inc(1);
		if (debug)
		{
			console.log("Response for GET=>"+ request.path)
		}
		request.response = result
		pendingResponses.push(request)
		break
	}
	case PkRequestType.Post: {
		if (debug)
		{
			console.log("POST=>"+ request.path)
		}
		const result = await axios.post(request.path, request.data, { headers: { authorization: request.token, "X-PluralKit-App": request.purpose === 'Member' ? memberPluralKitAppHeader : frontSyncPluralKitAppHeader } }).catch(handleError);
		(request.purpose === 'Member' ? memberCounter : frontSyncCounter).labels("POST", result?.status.toString() ?? "503").inc(1);
		if (debug)
		{
			console.log("Response for POST=>"+ request.path)
		}			
		request.response = result
		pendingResponses.push(request)
		break
	}
	case PkRequestType.Patch: {
		if (debug)
		{
			console.log("PATCH=>"+ request.path)
		}
		const result = await axios.patch(request.path, request.data, { headers: { authorization: request.token, "X-PluralKit-App": request.purpose === 'Member' ? memberPluralKitAppHeader : frontSyncPluralKitAppHeader } }).catch(handleError);
		(request.purpose === 'Member' ? memberCounter : frontSyncCounter).labels("PATCH", result?.status.toString() ?? "503").inc(1);
		if (debug)
		{
			console.log("Response for PATCH=>"+ request.path)
		}
		request.response = result
		pendingResponses.push(request)
		break
	}
	case PkRequestType.Delete: {
		if (debug)
		{
			console.log("DELETE=>"+ request.path)
		}
		const result = await axios.delete(request.path, { headers: { authorization: request.token, "X-PluralKit-App": request.purpose === 'Member' ? memberPluralKitAppHeader : frontSyncPluralKitAppHeader } }).catch(handleError);
		(request.purpose === 'Member' ? memberCounter : frontSyncCounter).labels("DELETE", result?.status.toString() ?? "503").inc(1);
		if (debug)
		{
			console.log("Response for DELETE=>"+ request.path)
		}
		request.response = result
		pendingResponses.push(request)
		break
	}
	}
	
	// Remove the completed request both from the pendingRequestIds array and mongo
	await removeQueuedRequest(request);
}