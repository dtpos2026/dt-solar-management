# DT Solar Pro v1.6: CRM

New module **CRM and Leads** (sidebar, under Suppliers). Everything else is unchanged; existing data is kept (additive migration v10 takes the usual automatic backup first).

* **Leads:** name, phone / WhatsApp, city, address, source, interest and system size (kW), expected value, assigned user, next follow-up date, notes.
* **Pipeline board:** New, Contacted, Site visit, Quotation sent, Negotiation, then Won or Lost. Drag a card to another column, or use the stage buttons in the lead window. Losing a lead asks for a reason; winning creates the customer (or links the existing one) and never creates a second.
* **Follow-ups:** Overdue, Today and Next 7 days lists; the notification bell shows how many follow-ups are overdue or due today.
* **Timeline:** log calls, WhatsApp chats, site visits, meetings and notes with the next follow-up date (Tomorrow, In 3 days, Next week). Logging a contact moves a New lead to Contacted.
* **From a lead:** open the WhatsApp chat, create a quotation for the customer, edit or delete the lead.
* **Numbers:** open leads, pipeline value, follow-ups due, won this month, conversion rate (won of won plus lost).
* **Permissions:** `crm.view` and `crm.manage`. Added automatically to the built-in roles on upgrade: Salesperson (both), Project Manager (view); Administrator and the owner have everything. Custom roles are not changed.
* **Per firm:** leads belong to the firm that works on them; a firm with leads cannot be deleted. Leads are part of every backup (database and JSON).
* **Sample data:** "Load sample solar business data" now also adds a few enquiries at different stages.

Tests: `tests/crm.test.ts` (9) and the desktop end-to-end run (sample summary, timeline, lost needs a reason, won creates the customer).
