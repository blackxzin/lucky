/** Erro cuja mensagem pode ser mostrada ao modelo e ao dono. Qualquer outro vira "Erro interno". */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
