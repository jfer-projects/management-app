# Feature analysis: what to add next

> **Status:** everything under "Recommended" below has been built except autopay/recurring bank debit (Stripe stays optional and off) and the items listed under "Don't build". See README for the current feature list.

Context: two landlords (you and your spouse), a condo, future tenants who will be one or two people. Compared against the small-landlord products Innago, TurboTenant, Avail, Baselane/Stessa, TenantCloud and Buildium, plus the feature checklists they publish.

## Where we stand

| Area | Typical competitor | This app |
|---|---|---|
| Tenant portal (balance, history, charges) | Yes | Yes, including upcoming scheduled rent |
| Recurring rent, automatic late fees | Yes | Yes |
| Rent collection | Card / ACH, autopay | Manual confirm today; Stripe ACH built but switched off |
| Maintenance requests | Yes, with photos | Yes, no photos, no private notes |
| Document storage (leases etc.) | Yes | Yes |
| E-signature, lease templates | Yes | No |
| Listings, applications, screening | Yes (TurboTenant, Avail, Zillow) | No |
| Email/SMS reminders | Yes | **No** |
| Bookkeeping / tax reports | Yes (Baselane, Stessa) | No |
| Multiple landlord logins | Usually | **No** (one landlord) |
| Co-tenants on one lease | Yes | **No** (see below) |

Most competitors are free to the landlord (they earn from tenant-paid fees), so cost is not a reason to build everything. Build what fits your situation, and use free tools for the rest.

## Recommended, in order

### 1. Fits your situation directly (do first)
1. **Second landlord login.** Today only one landlord account exists. Add "invite another landlord", and record who confirmed a payment or answered a ticket.
2. **Two people on one lease.** Right now each tenant account has its own balance, so two roommates or a couple would each get separate rent charges. The fix is one *lease/household* with a shared ledger and up to two logins, each with their own password. Also lets you record each person's name on the lease.
3. **Email notifications.** Nobody currently knows something happened unless they log in. Needed: rent due reminder, payment confirmed, "tenant reported a payment" and "new ticket" alerts to both landlords, ticket replies. A free email-sending tier is enough at your volume.
4. **Password reset by email, and 2FA for landlord accounts.** You will be holding tenant data and payment details.
5. **Automatic backups** of the database and uploaded documents to somewhere off the server. A self-hosted app with one disk is one failure from losing everything.

### 2. Valuable, moderate effort
6. **Security deposit tracking:** amount held, date received, deductions, return deadline. Many states set rules on where it is held, interest, and return deadlines, so check yours.
7. **Receipts and statements:** printable receipt per payment, and a downloadable tenant statement.
8. **Photos on tickets**, plus private landlord-only notes on a ticket.
9. **Renters insurance and lease-end tracking:** proof-of-insurance expiry, lease-end and renewal reminders.
10. **Move-in / move-out checklist** with photos. Strong protection if a deposit is ever disputed.
11. **Autopay / recurring bank debit** (turn on the Stripe piece when ready).
12. **Basic income and expense log** with CSV export for tax time (mortgage interest, repairs, HOA dues, insurance).

### 3. Condo-specific ideas
- Track **HOA dues and special assessments** as expenses (and as tenant charges if you pass them through).
- **Utility pass-through charges** (water, shared utilities) as itemized one-off charges with a note.
- **Property-wide notices** (already possible via "All tenants" documents) such as HOA rules, parking, and move-in rules.

### 4. Don't build; use a free tool and connect it
- **Listings, applications and tenant screening** (credit, criminal, eviction): TurboTenant, Avail and Zillow Rental Manager do this free or cheap. Screening involves federal fair-credit and fair-housing rules and a licensed vendor, so it is a poor DIY project.
- **E-signature:** keep signing in a service you trust and upload the signed PDF here (already supported). Building legally robust signing is not worth it for one unit.
- **Full accounting:** Stessa or Baselane are free if you outgrow a simple expense log.

## Legal and risk notes (not legal advice)
Late-fee amounts and grace periods, notice requirements, security-deposit handling, and rules about charging fees for rent payment all vary by state. Check yours before setting late fees or deposit terms. Keep Fair Housing in mind for anything involving screening or ads.

## Sources
- [14 Best Property Management Software for Small Landlords in 2026 (TurboTenant)](https://www.turbotenant.com/property-management-software/best-property-management-software-for-small-landlords/)
- [13 Best Property Management Software for Small Landlords (DoorLoop)](https://www.doorloop.com/blog/small-landlord-property-management-software)
- [12 Best Free Property Management Software for 2026 (Avail)](https://www.avail.com/education/articles/best-free-property-management-software-for-landlords)
- [Best Landlord Software 2026, independently scored](https://landlordtechlab.com/compare/best-landlord-software-2026)
- [Features of Property Management Software (TenantCloud)](https://www.tenantcloud.com/property-management/features-of-property-management-software)
- [Best Tenant Portal Software For Small Landlords (Magicdoor)](https://magicdoor.com/blog/tenant-portal-software-for-small-landlords/)
- [7 of the Best Landlord Software Options for 2026 (Buildium)](https://www.buildium.com/blog/best-landlord-software/)
- [15 Best Landlord Software 2026 (Baselane)](https://www.baselane.com/resources/15-best-landlord-software-platforms)
