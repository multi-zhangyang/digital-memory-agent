export interface AppHealth {
  status: "ok";
  capabilities: {
    chat: boolean;
    assets: true;
    memory: boolean;
    people: boolean;
    training: false;
  };
}

export interface ApiError {
  error: { code: string; message: string };
}
