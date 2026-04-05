import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark';

const sections = [
  {
    title: 'Use of Service',
    body: 'Lumeo provides software and network tooling for EV charging operations. You agree to use the service lawfully, follow posted operating rules, and avoid interfering with chargers, networks, accounts, or payment flows.',
  },
  {
    title: 'Accounts & Access',
    body: 'You are responsible for maintaining the confidentiality of your login credentials and for activity performed under your account. Access may be suspended or restricted for abuse, security risks, payment issues, or violations of operator policy.',
  },
  {
    title: 'Payments & Charging Sessions',
    body: 'Charging fees, idle fees, taxes, refunds, and billing adjustments may vary by site, operator configuration, jurisdiction, and payment processor behavior. By initiating a session, you authorize applicable charges under the pricing terms presented for that charger or network.',
  },
  {
    title: 'Availability & Limitations',
    body: 'Service availability depends on hardware health, upstream networks, third-party systems, maintenance windows, and field conditions. We do not guarantee uninterrupted charger access, session continuity, or error-free software behavior at all times.',
  },
  {
    title: 'Termination',
    body: 'Accounts may be terminated by the user or operator. Some records may be retained as required for fraud prevention, accounting, compliance, and legal obligations even after account deletion is requested.',
  },
  {
    title: 'Liability',
    body: 'To the maximum extent allowed by law, the service is provided on an as-available basis. Operators and service providers are not liable for indirect, incidental, or consequential damages arising from service interruptions, charging issues, payment disputes, or third-party failures.',
  },
];

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-4xl px-6 py-10 sm:px-8 lg:px-10">
        <div className="mb-10 flex items-center justify-between gap-4">
          <div>
            <div className="w-[180px]">
              <BrandMark />
            </div>
            <p className="mt-3 text-sm uppercase tracking-[0.24em] text-gray-500 dark:text-slate-400">Legal</p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Terms of Service</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-600 dark:text-slate-300">
              These terms govern use of the Lumeo charging portal, mobile application, and associated network services.
            </p>
          </div>
          <Link
            to="/login"
            className="rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:border-brand-400 hover:text-brand-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-brand-500 dark:hover:text-brand-300"
          >
            Back to sign in
          </Link>
        </div>

        <div className="rounded-3xl border border-gray-200 bg-white/90 p-6 shadow-sm shadow-gray-200/60 dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-black/20 sm:p-8">
          <div className="mb-8 rounded-2xl border border-brand-200/70 bg-brand-50/80 p-5 dark:border-brand-500/20 dark:bg-brand-500/10">
            <p className="text-sm font-semibold text-brand-700 dark:text-brand-300">Effective version: 1.0</p>
            <p className="mt-2 text-sm leading-6 text-brand-900/90 dark:text-brand-100/90">
              Continued use may require renewed consent if the terms version changes in a future release.
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
