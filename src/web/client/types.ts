import type {
  ChatSummary as ProtocolChatSummary,
  ConnectionRelationship as ProtocolConnectionRelationship,
  FeedPost as ProtocolFeedPost,
  FeedSubscription as ProtocolFeedSubscription,
  DiscoveryPostIndex as ProtocolDiscoveryPostIndex,
  DiscoveryReaction as ProtocolDiscoveryReaction,
  DeviceSyncEvent as ProtocolDeviceSyncEvent,
  IdentityFingerprint as ProtocolIdentityFingerprint,
  IdentityDocument as ProtocolIdentityDocument,
  NodeCapabilityDocument as ProtocolNodeCapabilityDocument,
  RelayCapability as ProtocolRelayCapability,
  TrustedDevice as ProtocolTrustedDevice,
  SearchResult as ProtocolSearchResult,
  SignableDeviceMembership as ProtocolSignableDeviceMembership,
  SignedDeviceMembership as ProtocolSignedDeviceMembership,
  SignableSyncEvent as ProtocolSignableSyncEvent,
  SignedSyncEvent as ProtocolSignedSyncEvent,
  SyncEventKind as ProtocolSyncEventKind,
  SocialNotification as ProtocolSocialNotification,
  StreamPost as ProtocolStreamPost
} from "../../protocol/types.js";

export type IdentityDocument = ProtocolIdentityDocument;
export type IdentityFingerprint = ProtocolIdentityFingerprint;
export type NodeCapabilityDocument = ProtocolNodeCapabilityDocument;
export type RelayCapability = ProtocolRelayCapability;
export type ConnectionRelationship = ProtocolConnectionRelationship;
export type FeedSubscription = ProtocolFeedSubscription;
export type DiscoveryPostIndex = ProtocolDiscoveryPostIndex;
export type DiscoveryReaction = ProtocolDiscoveryReaction;
export type TrustedDevice = ProtocolTrustedDevice;
export type DeviceSyncEvent = ProtocolDeviceSyncEvent;
export type SignableDeviceMembership = ProtocolSignableDeviceMembership;
export type SignedDeviceMembership = ProtocolSignedDeviceMembership;
export type SignableSyncEvent = ProtocolSignableSyncEvent;
export type SignedSyncEvent = ProtocolSignedSyncEvent;
export type SyncEventKind = ProtocolSyncEventKind;
export type SocialNotification = ProtocolSocialNotification;

export type LocalIdentity = {
  handle: string;
  bio: string;
  status: string;
  privacyMode: string;
  onionState: string;
  fingerprintSnippet: string;
  portalTransport: string;
  relayTransport: string;
  relayWarning?: string;
  nodeName?: string;
  nodeBaseUrl?: string;
  nodeOnionBaseUrl?: string | null;
  nodeRoles?: string[];
  nodeRelaySummary?: string;
};

export type LookupState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | {
      status: "resolved";
      query: string;
      identity: IdentityDocument;
      fingerprint: string;
      relationship?: ConnectionRelationship;
      subscription?: FeedSubscription | null;
    }
  | { status: "error"; query: string; message: string };

export type SignupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "waiting_for_local_data"; attempt: number }
  | { status: "created"; identity: IdentityDocument; fingerprint: string; backupCode: string }
  | { status: "error"; message: string };

export type SigninState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "waiting_for_local_data"; attempt: number }
  | { status: "signed_in"; identity: IdentityDocument }
  | { status: "error"; message: string };

export type SearchResult = ProtocolSearchResult & {
  relationship?: ConnectionRelationship;
  subscription?: FeedSubscription | null;
};

export type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "results"; query: string; results: SearchResult[] }
  | { status: "error"; query: string; message: string };

export type DiscoveryMode = "recent" | "rising" | "hot";

export type DiscoveryState =
  | { status: "idle"; mode: DiscoveryMode }
  | { status: "loading"; mode: DiscoveryMode }
  | { status: "loaded"; mode: DiscoveryMode; posts: DiscoveryPostIndex[] }
  | { status: "error"; mode: DiscoveryMode; message: string };

export type StreamPost = ProtocolStreamPost;
export type FeedPost = ProtocolFeedPost;

export type ChatSummary = ProtocolChatSummary;
