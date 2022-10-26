/* eslint-disable no-mixed-spaces-and-tabs */
import { addPendingRequest, PkRequestType } from "./requestController";
import { PkInsertMember, PkMember, PkSwitch, PkUpdateMember } from "./types";

export class PkAPIError extends Error {
	public status: number;
	public data: PkErrorData;

	constructor(message: string, statusCode: number, errorData: PkErrorData) {
		super(message);
  
		// 👇️ because we are extending a built-in class
		Object.setPrototypeOf(this, PkAPIError.prototype);

		this.status = statusCode;
		this.data = errorData;
	}
}

export interface PkErrorData {
	code: number;
	message: string;
}

export class PkAPI {
	private readonly apiBaseUrl = 'https://api.pluralkit.me/v2';
    private readonly token: string = '';
    private readonly purpose: 'Member' | 'FrontSync';
    public systemId: string | null = null;
 
    constructor(token: string, purpose: 'Member' | 'FrontSync') {
    	this.token = token;
    	this.purpose = purpose;
    }

    private performPkRequest = async (path: string, type: PkRequestType, data?: any): Promise<any | never> => {
    	try {
    		const result = await addPendingRequest({
    			path,
    			token: this.token,
    			response: null,
    			data,
    			type,
    			purpose: this.purpose,
    		});

    		if (result?.status === 200) {
    			return result.data;
    		} else if (result) {
    			throw new PkAPIError('There was an error completing the PluralKit request', result.status, result.data);
    		} else {
    			throw new PkAPIError('There was an error completing the PluralKit request', 0, { code: 0, message: ''});
    		}
    	} catch (e) {
    		throw new PkAPIError('There was an error completing the PluralKit request', 0, { code: 0, message: ''});
    	}
    }

	public setSystemId = async (): Promise<void> => {
		if (this.systemId === null) {
			const getSystemResult = await this.performPkRequest(`${this.apiBaseUrl}/systems/@me`, PkRequestType.Get);

			this.systemId = getSystemResult.id;
		}
	}

	public getMembers = async (): Promise<PkMember[]> =>
		this.performPkRequest(`${this.apiBaseUrl}/systems/@me/members`, PkRequestType.Get);

	public getMember = async (memberPkId: string): Promise<PkMember> =>
		this.performPkRequest(`${this.apiBaseUrl}/members/${memberPkId}`, PkRequestType.Get);

	public insertMember = async (memberData: PkInsertMember): Promise<PkMember> =>
		this.performPkRequest(`${this.apiBaseUrl}/members`, PkRequestType.Post, memberData);

	public updateMember = async (memberPkId: string, newMemberData: PkUpdateMember): Promise<PkMember> =>
		this.performPkRequest(`${this.apiBaseUrl}/members/${memberPkId}`, PkRequestType.Patch, newMemberData);

	public deleteMember = async (memberPkId: string): Promise<void> =>
		this.performPkRequest(`${this.apiBaseUrl}/members/${memberPkId}`, PkRequestType.Delete);

	// Get pk switches using provided before and limit parameters
	public getSwitches = async (before: number, limit: number): Promise<PkSwitch[]> => {
		await this.setSystemId();

		return this.performPkRequest(`${this.apiBaseUrl}/systems/${this.systemId}/switches?before=${before}&limit=${limit}`, PkRequestType.Get);
	}

	// Get all switches between two timestamps (including a single switch on either side of the two timestamps if there are no switches with the exact timestamp)
	public getSwitchesBetweenTwoTimestamps = async (startTime: number, endTime: number): Promise<PkSwitch[]> => {
		const getSingleSwitchClosestToStartTime = await this.getSwitches(startTime + 1, 1);

		const endTimePlusThreeHours = endTime + (60 * 60 * 3 * 1000);

		const endTimeSwitches = await this.recursivelyGrabSwitches([], startTime, false, endTimePlusThreeHours);

		return this.getUniqueSwitchesWithBookEnds(getSingleSwitchClosestToStartTime.concat(endTimeSwitches), startTime, endTime);
	}

	private recursivelyGrabSwitches = async (switches: PkSwitch[], until: number, forward: boolean, nextBefore: number): Promise<PkSwitch[]> => {
		const nextSwitches = await this.getSwitches(nextBefore, 100);

		switches = switches.concat(nextSwitches);

		const untilTimestampReached = forward ?
			nextSwitches.find((switchObj) => new Date(switchObj.timestamp).getTime() >= until) :
			nextSwitches.find((switchObj) => new Date(switchObj.timestamp).getTime() <= until);

		const newNextBefore = !forward ?
			new Date(this.getEarliestSwitchInArray(switches).timestamp).getTime() :
			nextBefore + (60 * 60 * 3 * 1000);

		return untilTimestampReached ? switches : this.recursivelyGrabSwitches(switches, until, forward, newNextBefore);
	}

	private getUniqueSwitchesWithBookEnds = (arrayOfSwitches: PkSwitch[], startTime: number, endTime: number): PkSwitch[] => {
		const uniqueSwitches: PkSwitch[] = [];

		const firstSwitch = this.getClosestSwitchToTimestamp(arrayOfSwitches, startTime, true);
		const lastSwitch = this.getClosestSwitchToTimestamp(arrayOfSwitches, endTime, false);

		arrayOfSwitches.forEach((switchObj) => {
			const existingSwitch = uniqueSwitches.find((uniqueSwitch) => uniqueSwitch.id === switchObj.id);

			if (!existingSwitch && (new Date(switchObj.timestamp).getTime() <= new Date(lastSwitch.timestamp).getTime() && new Date(switchObj.timestamp).getTime() >= new Date(firstSwitch.timestamp).getTime())) {
				uniqueSwitches.push(switchObj);
			}
		});

		return uniqueSwitches;
	}

	private getClosestSwitchToTimestamp = (arrayOfSwitches: PkSwitch[], timestamp: number, less: boolean): PkSwitch => arrayOfSwitches.reduce((accum: PkSwitch | undefined, currentSwitch) => {
		if (less) {
			if ((accum === undefined && new Date(currentSwitch.timestamp).getTime() <= timestamp) ||
				(accum !== undefined && new Date(currentSwitch.timestamp).getTime() <= timestamp && new Date(currentSwitch.timestamp).getTime() > new Date(accum.timestamp).getTime())) {
				accum = currentSwitch;
			}
		} else {
			if ((accum === undefined && new Date(currentSwitch.timestamp).getTime() >= timestamp) ||
				(accum !== undefined && new Date(currentSwitch.timestamp).getTime() >= timestamp && new Date(currentSwitch.timestamp).getTime() < new Date(accum.timestamp).getTime())) {
				accum = currentSwitch;
			}
		}

		return accum;
	}, undefined) as PkSwitch;

	public getEarliestSwitchInArray = (arrayOfSwitches: PkSwitch[]): PkSwitch => arrayOfSwitches.reduce((accum: PkSwitch | undefined, currentSwitch) => {
		if (accum === undefined || new Date(currentSwitch.timestamp).getTime() < new Date(accum.timestamp).getTime()) {
			accum = currentSwitch;
		}

		return accum;
	}, undefined) as PkSwitch;

	public getLatestSwitchInArray = (arrayOfSwitches: PkSwitch[]): PkSwitch => arrayOfSwitches.reduce((accum: PkSwitch | undefined, currentSwitch) => {
		if (accum === undefined || new Date(currentSwitch.timestamp).getTime() > new Date(accum.timestamp).getTime()) {
			accum = currentSwitch;
		}

		return accum;
	}, undefined) as PkSwitch;

	// Get a single pk switch
	public getSwitch = async (switchPkId: string): Promise<PkSwitch> => {
		await this.setSystemId();

		return this.performPkRequest(`${this.apiBaseUrl}/systems/${this.systemId}/switches/${switchPkId}`, PkRequestType.Get);
	}

	public insertSwitch = async (switchTime: number, switchMemberPkIds: string[]): Promise<PkSwitch> => {
		await this.setSystemId();

		const switchData = {
			timestamp: new Date(switchTime).toISOString(),
			members: switchMemberPkIds,
		};

		return this.performPkRequest(`${this.apiBaseUrl}/systems/${this.systemId}/switches`, PkRequestType.Post, switchData);
	}

	public updateSwitchTime = async (switchPkId: string, newTime: number): Promise<PkSwitch> => {
		await this.setSystemId();

		const changedSwitchData = {
			timestamp: new Date(newTime).toISOString(),
		};

		return this.performPkRequest(`${this.apiBaseUrl}/systems/${this.systemId}/switches/${switchPkId}`, PkRequestType.Patch, changedSwitchData);
	}

	public updateSwitchMembers = async (switchPkId: string, newMemberPkIds: string[]): Promise<PkSwitch> => {
		await this.setSystemId();

		const changedSwitchData = {
			members: newMemberPkIds,
		};

		return this.performPkRequest(`${this.apiBaseUrl}/systems/${this.systemId}/switches/${switchPkId}/members`, PkRequestType.Patch, changedSwitchData);
	}

	public replaceSingleSwitchMember = async (switchPkId: string, oldMemberPkId: string, newMemberPkId: string) => {
		const existingSwitch = await this.getSwitch(switchPkId);

		const newSwitchMembers = existingSwitch.members.map((memberPkId) => memberPkId === oldMemberPkId ? newMemberPkId : memberPkId);

		return this.updateSwitchMembers(switchPkId, newSwitchMembers);
	}

	public deleteSwitch = async (switchPkId: string): Promise<void> => {
		await this.setSystemId();

		return this.performPkRequest(`https://api.pluralkit.me/v2/systems/${this.systemId}/switches/${switchPkId}`, PkRequestType.Delete);
	}
}