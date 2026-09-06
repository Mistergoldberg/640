type WebkitDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export function fullscreenElement(fullscreenDocument: Document = document) {
  const vendorDocument = fullscreenDocument as WebkitDocument;
  return fullscreenDocument.fullscreenElement ?? vendorDocument.webkitFullscreenElement ?? null;
}

export function fullscreenSupported(fullscreenDocument: Document = document) {
  const root = fullscreenDocument.documentElement as WebkitElement;
  return typeof root.requestFullscreen === "function" || typeof root.webkitRequestFullscreen === "function";
}

export function requestDocumentFullscreen(fullscreenDocument: Document = document): Promise<boolean> {
  if (fullscreenElement(fullscreenDocument)) {
    return Promise.resolve(true);
  }

  const root = fullscreenDocument.documentElement as WebkitElement;

  try {
    const request = root.requestFullscreen
      ? root.requestFullscreen({ navigationUI: "hide" })
      : root.webkitRequestFullscreen?.();

    if (!request && !fullscreenSupported(fullscreenDocument)) {
      return Promise.resolve(false);
    }

    return Promise.resolve(request).then(
      () => Boolean(fullscreenElement(fullscreenDocument)),
      () => false
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function exitDocumentFullscreen(fullscreenDocument: Document = document): Promise<boolean> {
  if (!fullscreenElement(fullscreenDocument)) {
    return Promise.resolve(true);
  }

  const vendorDocument = fullscreenDocument as WebkitDocument;

  try {
    const exit = fullscreenDocument.exitFullscreen
      ? fullscreenDocument.exitFullscreen()
      : vendorDocument.webkitExitFullscreen?.();

    if (!exit && typeof fullscreenDocument.exitFullscreen !== "function" && typeof vendorDocument.webkitExitFullscreen !== "function") {
      return Promise.resolve(false);
    }

    return Promise.resolve(exit).then(
      () => !fullscreenElement(fullscreenDocument),
      () => false
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function subscribeToFullscreenChanges(listener: () => void, fullscreenDocument: Document = document) {
  fullscreenDocument.addEventListener("fullscreenchange", listener);
  fullscreenDocument.addEventListener("webkitfullscreenchange", listener);

  return () => {
    fullscreenDocument.removeEventListener("fullscreenchange", listener);
    fullscreenDocument.removeEventListener("webkitfullscreenchange", listener);
  };
}
