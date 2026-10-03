/**
 * Decorateur @CurrentUser — extrait l'utilisateur authentifié posé par JwtAuthGuard.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    return req.auth;
  },
);
