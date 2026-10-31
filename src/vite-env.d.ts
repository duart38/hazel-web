/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** where the installer gets Hazel's camera files; Hazel-firmware on GitHub when unset */
  readonly VITE_HAZEL_FIRMWARE?: string
}
