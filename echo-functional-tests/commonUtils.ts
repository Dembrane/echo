import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authAdminStorePath = path.join(__dirname, 'playwright/.auth/admin.json');
const authDir = path.dirname(authAdminStorePath);

export function getCommonConfig() {
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    if (!process.env.DASHBOARD_URL || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
        throw new Error('Missing environment variables');
    }

    return {

        authAdminStorePath,

        dashboardUrl: process.env.DASHBOARD_URL!,
        auth: {
            admin: {
                email: process.env.ADMIN_EMAIL!,
                password: process.env.ADMIN_PASSWORD!,
            },
            user: {
                email: process.env.USER_EMAIL,
                password: process.env.USER_PASSWORD,
            }
        },

        portalUrl: process.env.PORTAL_URL,
        // @robert finish this later
    }
}
