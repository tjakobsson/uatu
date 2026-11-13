import { test } from "./hub-fixtures";
import { receiptRegressions } from "./chat-receipt-regressions";

test.use({ hubChatPolicy: true, hubChatPolicyTrust: false, hubWorkspaces: ["receipt-regression"] });
receiptRegressions(false);
