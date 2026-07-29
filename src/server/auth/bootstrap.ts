import { config } from '../config.js';
import { db, nowIso, primaryAccountId } from '../db/index.js';
import { passwordProblem } from '../lib/password.js';
import { addMembership, createUser, findUserByEmail, siteAdminCount } from './store.js';

/**
 * Ensures the installation has a way in.
 *
 * There is no public signup, so a fresh or freshly-upgraded database would
 * otherwise have data but no user who can reach it. On first boot this promotes
 * the configured address to site admin and makes it owner of the account that
 * adopted the pre-tenancy data.
 *
 * Runs only while no site admin exists, so rotating the env vars later does not
 * silently reset a password or resurrect a removed admin.
 */
export async function bootstrapSiteAdmin() {
  if (siteAdminCount() > 0) return;

  const email = config.bootstrapAdminEmail.trim();
  const password = config.bootstrapAdminPassword;

  if (!email || !password) {
    console.warn(
      '\n  WARNING: no site administrator exists and LEADMAN_ADMIN_EMAIL / LEADMAN_ADMIN_PASSWORD\n' +
        '  are not set, so nobody can sign in. Set both and restart to create the first admin.\n',
    );
    return;
  }

  const problem = passwordProblem(password);
  if (problem) {
    console.warn(`\n  WARNING: LEADMAN_ADMIN_PASSWORD rejected — ${problem}\n  No administrator was created.\n`);
    return;
  }

  const accountId = primaryAccountId();
  const existing = findUserByEmail(email);

  if (existing) {
    // The address is already a user (an invited member, say). Promote rather
    // than duplicate — email is the identity, and it is unique.
    db.prepare('UPDATE users SET is_site_admin = 1, updated_at = ? WHERE id = ?').run(
      nowIso(),
      existing.id,
    );
    addMembership(existing.id, accountId, 'owner');
    console.log(`[auth] promoted ${existing.email} to site administrator`);
    return;
  }

  const user = await createUser({ email, password, isSiteAdmin: true });
  addMembership(user.id, accountId, 'owner');
  console.log(`[auth] created site administrator ${user.email} and made them owner of the primary account`);
}
