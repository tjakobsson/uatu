import { test } from "./hub-fixtures";
import { receiptRegressions } from "./chat-receipt-regressions";

test.use({ hubChatPolicy: true, hubChatPolicyTrust: true, hubWorkspaces: ["receipt-regression"] });
receiptRegressions(true);
