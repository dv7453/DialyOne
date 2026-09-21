export type MicAccess = "granted" | "denied" | "unavailable";

export async function requestMicAccess(): Promise<MicAccess> {
  if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return "granted";
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        return "unavailable";
      }
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        return "denied";
      }
    }
    return "denied";
  }
}
