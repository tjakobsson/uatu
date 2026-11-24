type NotificationOptions = { apiUrl: string; workerUrl: string; beforeRegister?: () => Promise<void> };
export function mountNotifications(options: NotificationOptions & { stateUrl: string; hosts: string }): void;
export function reconcileNotifications(options: NotificationOptions): void;
declare const assetPath: string;
export default assetPath;
