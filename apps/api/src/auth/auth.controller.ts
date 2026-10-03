/**
 * Contrôleur d'authentification (README §39, §74) : login / refresh / me.
 */
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth';
import { JwtAuthGuard } from './auth';
import { CurrentUser } from '../common/current-user';
import type { AuthUser } from './auth';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: { email: string; password: string }, @Req() req: any) {
    const ip = req.ip;
    const ua = req.headers['user-agent'];
    return this.auth.login(body.email, body.password, ip, ua);
  }

  @Post('refresh')
  refresh(@Body() body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.buildAuthUser(user.userId);
  }
}
