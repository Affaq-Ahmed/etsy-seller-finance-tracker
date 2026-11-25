import { postOnboarding } from '@/server/api/onboarding';
import { sessionRoute } from '@/server/http/routes';

export const POST = sessionRoute(postOnboarding);
