export interface PkSwitch {
    id: string;
    timestamp: string; // ISO date string
    members: string[];
}

export interface PkSystem {
    id: string;
    uuid: string;
    name: string; // 100 character limit
    description: string | null; // 1000 character limit
    tag: string;
    pronouns: string | null; // 100 character limit
    avatar_url: string | null; // 256 character limit - must be a publicly accessible URL
    banner: string | null; // 256 character limit - must be a publicly accessible URL
    color: string; // 6-character hex code, no # at the beginning
    created: string; // ISO date string
    privacy: PkSystemPrivacy;
}

export interface PkSystemPrivacy {
    description_privacy: 'private' | 'public' | null;
    pronoun_privacy: 'private' | 'public' | null;
    member_list_privacy: 'private' | 'public' | null;
    group_list_privacy: 'private' | 'public' | null;
    front_privacy: 'private' | 'public' | null;
    front_history_privacy: 'private' | 'public' | null;
}

export interface PkMember {
    id: string;
    system: string;
    uuid: string;
    name: string; // 100 character limit
    display_name: string | null; // 100 character limit
    color: string; // 6-character hex code, no # at the beginning
    birthday: string | null; // YYYY-MM-DD format, 0004 hides the year
    pronouns: string | null; // 100 character limit
    avatar_url: string | null; // 256 character limit - must be a publicly accessible URL
    banner: string | null; // 256 character limit - must be a publicly accessible URL
    description: string | null; // 1000 character limit
    created: string | null; // ISO date string
    proxy_tags: PkMemberProxyTag[];
    keep_proxy: boolean;
    privacy: PkMemberPrivacy;
}

export interface PkMemberProxyTag {
    prefix: string | null;
    suffix: string | null;
}

export interface PkMemberPrivacy {
    visibility: 'private' | 'public' | null;
    name_privacy: 'private' | 'public' | null;
    description_privacy: 'private' | 'public' | null;
    birthday_privacy: 'private' | 'public' | null;
    pronoun_privacy: 'private' | 'public' | null;
    avatar_privacy: 'private' | 'public' | null;
    metadata_privacy: 'private' | 'public' | null;
}

export interface PkGroup {
    id: string;
    uuid: string;
    name: string; // 100 character limit
    display_name: string | null; // 100 character limit
    color: string; // 6-character hex code, no # at the beginning
    icon: string | null; // 256 character limit - must be a publicly accessible URL
    banner: string | null; // 256 character limit - must be a publicly accessible URL
    description: string | null; // 1000 character limit
    privacy: PkGroupPrivacy;
}

export interface PkGroupPrivacy {
    name_privacy: 'private' | 'public' | null;
    description_privacy: 'private' | 'public' | null;
    icon_privacy: 'private' | 'public' | null;
    list_privacy: 'private' | 'public' | null;
    metadata_privacy: 'private' | 'public' | null;
    visibility: 'private' | 'public' | null;
}

export interface PkInsertMember {
    name: string; // 100 character limit
    display_name?: string | null; // 100 character limit
    color: string; // 6-character hex code, no # at the beginning
    birthday?: string | null; // YYYY-MM-DD format, 0004 hides the year
    pronouns?: string | null; // 100 character limit
    avatar_url?: string | null; // 256 character limit - must be a publicly accessible URL
    banner?: string | null; // 256 character limit - must be a publicly accessible URL
    description?: string | null; // 1000 character limit
    proxy_tags?: PkMemberProxyTag[];
    keep_proxy?: boolean;
    privacy?: PkMemberPrivacy;
}

export interface PkUpdateMember {
    name?: string; // 100 character limit
    display_name?: string | null; // 100 character limit
    color?: string; // 6-character hex code, no # at the beginning
    birthday?: string | null; // YYYY-MM-DD format, 0004 hides the year
    pronouns?: string | null; // 100 character limit
    avatar_url?: string | null; // 256 character limit - must be a publicly accessible URL
    banner?: string | null; // 256 character limit - must be a publicly accessible URL
    description?: string | null; // 1000 character limit
    proxy_tags?: PkMemberProxyTag[];
    keep_proxy?: boolean;
    privacy?: PkMemberPrivacy;
}