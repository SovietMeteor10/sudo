export interface PasskeyAccessProvider {
  registerPasskey(handle: string): Promise<void>;
  authenticateWithPasskey(handle: string): Promise<void>;
  isAvailable(): boolean;
}

export class BrowserPasskeyAccessProvider implements PasskeyAccessProvider {
  isAvailable(): boolean {
    return (
      "PublicKeyCredential" in window
      && navigator.credentials !== undefined
      && typeof navigator.credentials.create === "function"
      && typeof navigator.credentials.get === "function"
    );
  }

  async registerPasskey(_handle: string): Promise<void> {
    // TODO: request a challenge from the server, call navigator.credentials.create,
    // and store only public credential metadata server-side. The private
    // credential must remain device-held.
    throw new Error("passkey registration is not implemented yet");
  }

  async authenticateWithPasskey(_handle: string): Promise<void> {
    // TODO: request an assertion challenge, call navigator.credentials.get, and
    // verify it server-side against stored public credential metadata.
    throw new Error("passkey sign-in is not implemented yet");
  }
}
