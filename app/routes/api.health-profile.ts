import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import { authenticate } from '../shopify.server';
import {
  findOrCreateProfile,
  getHealthProfile,
  saveHealthProfile,
  type HealthProfile,
} from '../lib/supabase.server';
import { healthInputSchema } from '../../packages/health-core/src/validation';

// Map HealthInputs (camelCase) to database columns (snake_case)
interface HealthInputs {
  heightCm?: number;
  weightKg?: number;
  waistCm?: number;
  sex?: 'male' | 'female';
  birthYear?: number;
  birthMonth?: number;
  hba1c?: number;
  ldlC?: number;
  hdlC?: number;
  triglycerides?: number;
  fastingGlucose?: number;
  systolicBp?: number;
  diastolicBp?: number;
}

// Convert HealthInputs to database format
function inputsToDb(inputs: HealthInputs) {
  return {
    height_cm: inputs.heightCm ?? null,
    weight_kg: inputs.weightKg ?? null,
    waist_cm: inputs.waistCm ?? null,
    sex: inputs.sex ?? null,
    birth_year: inputs.birthYear ?? null,
    birth_month: inputs.birthMonth ?? null,
    hba1c: inputs.hba1c ?? null,
    ldl_c: inputs.ldlC ?? null,
    hdl_c: inputs.hdlC ?? null,
    triglycerides: inputs.triglycerides ?? null,
    fasting_glucose: inputs.fastingGlucose ?? null,
    systolic_bp: inputs.systolicBp ?? null,
    diastolic_bp: inputs.diastolicBp ?? null,
  };
}

// Convert database format to HealthInputs
function dbToInputs(profile: HealthProfile): HealthInputs {
  const inputs: HealthInputs = {};

  if (profile.height_cm !== null) inputs.heightCm = profile.height_cm;
  if (profile.weight_kg !== null) inputs.weightKg = profile.weight_kg;
  if (profile.waist_cm !== null) inputs.waistCm = profile.waist_cm;
  if (profile.sex !== null) inputs.sex = profile.sex;
  if (profile.birth_year !== null) inputs.birthYear = profile.birth_year;
  if (profile.birth_month !== null) inputs.birthMonth = profile.birth_month;
  if (profile.hba1c !== null) inputs.hba1c = profile.hba1c;
  if (profile.ldl_c !== null) inputs.ldlC = profile.ldl_c;
  if (profile.hdl_c !== null) inputs.hdlC = profile.hdl_c;
  if (profile.triglycerides !== null) inputs.triglycerides = profile.triglycerides;
  if (profile.fasting_glucose !== null) inputs.fastingGlucose = profile.fasting_glucose;
  if (profile.systolic_bp !== null) inputs.systolicBp = profile.systolic_bp;
  if (profile.diastolic_bp !== null) inputs.diastolicBp = profile.diastolic_bp;

  return inputs;
}

// Extract the verified customer ID from an app proxy request
function getCustomerId(request: Request): string | null {
  const url = new URL(request.url);
  const customerId = url.searchParams.get('logged_in_customer_id');
  return customerId || null;
}

// Look up customer email via Shopify Admin API
async function getCustomerEmail(admin: any, customerId: string): Promise<string | null> {
  try {
    const response = await admin.graphql(`
      query getCustomer($id: ID!) {
        customer(id: $id) {
          email
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const { data } = await response.json();
    return data?.customer?.email || null;
  } catch (error) {
    console.error('Error looking up customer email:', error);
    return null;
  }
}

// GET - Load health profile (authenticated via app proxy HMAC)
export async function loader({ request }: LoaderFunctionArgs) {
  // Verify HMAC signature — throws if invalid
  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const email = admin ? await getCustomerEmail(admin, customerId) : null;
    const profile = await findOrCreateProfile(customerId, email || undefined);
    if (!profile) {
      return json({ success: false, error: 'Could not find or create profile' }, { status: 500 });
    }

    const healthProfile = await getHealthProfile(profile.id);
    if (!healthProfile) {
      return json({ success: true, data: null });
    }

    return json({ success: true, data: dbToInputs(healthProfile) });
  } catch (error) {
    console.error('Error loading health profile:', error);
    return json({ success: false, error: 'Failed to load health profile' }, { status: 500 });
  }
}

// POST - Save health profile
// PUT - Migrate localStorage data
export async function action({ request }: ActionFunctionArgs) {
  // Verify HMAC signature — throws if invalid
  const { admin } = await authenticate.public.appProxy(request);

  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { inputs, migrate } = body as { inputs: unknown; migrate?: boolean };

    // Validate inputs against Zod schema (partial — all fields optional for saves)
    const validation = healthInputSchema.partial().safeParse(inputs);
    if (!validation.success) {
      return json(
        { success: false, error: 'Invalid input', details: validation.error.issues },
        { status: 400 },
      );
    }
    const validatedInputs = validation.data as HealthInputs;

    const email = admin ? await getCustomerEmail(admin, customerId) : null;
    const profile = await findOrCreateProfile(customerId, email || undefined);
    if (!profile) {
      return json({ success: false, error: 'Could not find or create profile' }, { status: 500 });
    }

    // For migrate requests, check if there's existing cloud data
    if (migrate) {
      const existingHealth = await getHealthProfile(profile.id);
      if (existingHealth) {
        return json({
          success: true,
          data: dbToInputs(existingHealth),
          migrated: false,
          message: 'Existing cloud data found, skipping migration',
        });
      }
    }

    const dbData = inputsToDb(validatedInputs);
    const savedProfile = await saveHealthProfile(profile.id, dbData);

    if (!savedProfile) {
      return json({ success: false, error: 'Failed to save health profile' }, { status: 500 });
    }

    return json({
      success: true,
      data: dbToInputs(savedProfile),
      migrated: migrate || false,
    });
  } catch (error) {
    console.error('Error saving health profile:', error);
    return json({ success: false, error: 'Failed to save health profile' }, { status: 500 });
  }
}
