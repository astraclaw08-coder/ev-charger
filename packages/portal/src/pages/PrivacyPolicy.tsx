
const sections = [
  {
    title: 'Information We Collect',
    body: 'We collect the information required to operate charging services, including account details, contact information, charging session activity, support communications, device telemetry, and payment-related references. We do not intentionally store full payment card PAN or CVV in application profile fields.',
  },
  {
    title: 'How We Use Information',
    body: 'We use personal information to provide charging access, process transactions, support customer service, maintain network reliability, detect abuse, comply with legal obligations, and improve the performance and safety of the platform.',
  },
  {
    title: 'Retention & Deletion',
    body: 'When an account deletion request is made, personally identifiable profile information may be queued for anonymization after a compliance and billing retention window. Charging records may be retained in anonymized form for financial, tax, fraud prevention, and operational reporting purposes.',
  },
  {
    title: 'Sharing & Processors',
    body: 'We may share data with service providers that help us operate authentication, cloud hosting, payments, transactional messaging, analytics, and customer support. These providers only receive data needed to perform their services on our behalf.',
  },
  {
    title: 'Your Choices',
    body: 'You may update account profile information, request deletion of your account, and review the current policy version through the portal or app. Continued use after policy updates may require renewed consent before access continues.',
  },
  {
    title: 'Contact',
    body: 'For privacy questions, access requests, or deletion inquiries, contact the operator support channel associated with your deployment or your charging network administrator.',
  },
];

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-4xl px-6 py-10 sm:px-8 lg:px-10">
        <div className="mb-10">
          <p className="text-sm uppercase tracking-[0.24em] text-gray-500 dark:text-slate-400">Legal</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Privacy Policy</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-600 dark:text-slate-300">
            This policy explains how Lumeo handles personal information used to operate EV charging services across the portal and mobile experience.
          </p>
        </div>

        <div className="rounded-3xl border border-gray-200 bg-white/90 p-6 shadow-sm shadow-gray-200/60 dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-black/20 sm:p-8">
          <div className="mb-8 rounded-2xl border border-brand-200/70 bg-brand-50/80 p-5 dark:border-brand-500/20 dark:bg-brand-500/10">
            <p className="text-sm font-semibold text-brand-700 dark:text-brand-300">Effective version: 1.0</p>
            <p className="mt-2 text-sm leading-6 text-brand-900/90 dark:text-brand-100/90">
              If the policy version changes, users may be prompted to review and accept the updated policy before continuing to use authenticated features.
            </p>
          </div>

          <div className="space-y-8">
            {sections.map((section) => (
              <section key={section.title} className="border-b border-gray-200 pb-8 last:border-b-0 last:pb-0 dark:border-slate-800">
                <h2 className="text-xl font-bold tracking-tight">{section.title}</h2>
                <p className="mt-3 text-sm leading-7 text-gray-600 dark:text-slate-300">{section.body}</p>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
