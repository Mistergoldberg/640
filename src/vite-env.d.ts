/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_BASE_PATH?: string;
  readonly VITE_MEDIA_BASE_URL?: string;
  readonly VITE_BUILD_COMMIT?: string;
  readonly VITE_SEAMLESS_YEAR_SEGMENTS?: string;
  readonly VITE_HOMEPAGE_AUTOPLAYER?: string;
}
