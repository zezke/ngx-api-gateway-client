import * as url from 'url';
import { Injectable, Inject } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/first';
import 'rxjs/add/operator/switchMap';
import * as aws4 from 'aws-v4-sign-small';
import * as AWS from 'aws-sdk';

import { AWSHttpService } from './aws-http.service';
import { AWS_HTTP_CONFIG } from './aws-http.token';
import { Config } from './entities/config';
import { isExpired } from './utils';

@Injectable()
export class AWSHttpInterceptor implements HttpInterceptor {

	private refreshing = false;

	constructor(
		@Inject(AWS_HTTP_CONFIG) private config: Config,
		private awsHttpService: AWSHttpService
	) {
		if (this.config.baseUrl && this.config.baseUrl.endsWith('/')) {
			this.config.baseUrl = this.config.baseUrl.slice(0, this.config.baseUrl.length - 1);
		}
	}

	intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
		if (AWS.config.credentials && isExpired((AWS.config.credentials as any).expireTime) && !this.refreshing) {
			const refreshRequest = this.awsHttpService.refreshRequest();

			// Only refresh if a refresh request is defined
			if (refreshRequest) {
				// Make sure we only refresh once
				this.refreshing = true;

				// Pause all incoming requests!
				this.awsHttpService.paused$.next(true);

				// Invoke the refresh request
				return this.invoke(refreshRequest, next)
					// Only listen for `HttpResponse` results, not all the intermediate events
					.filter(event => event instanceof HttpResponse)
					.switchMap((result: HttpResponse<any>) => {
						const credentials = this.awsHttpService.onRefreshHandler(result.body);

						return this.awsHttpService.setCognitoCredentials(credentials);
					})
					.switchMap(() => {
						this.refreshing = false;
						this.awsHttpService.paused$.next(false);

						return this.invoke(request, next);
					});
			}
		}

		// Requests are paused when credentials are being generated or refreshed
		return this.awsHttpService.paused$
			.filter(isPaused => !isPaused)
			.first()
			.switchMap(() => this.invoke(request, next));
	}

	private invoke(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
		let headers: any = {
			Accept: 'application/json',
			'Content-Type': 'application/json'
		};

		if (this.config.apiKey) {
			// Set `x-api-key` if an API key is defined
			headers['x-api-key'] = this.config.apiKey;
		}

		let requestUrl = request.url;

		if (this.config.baseUrl) {
			if (!requestUrl.startsWith('/')) {
				// Remove leading slash
				requestUrl = '/' + requestUrl;
			}

			requestUrl = this.config.baseUrl + requestUrl;
		}

		if (AWS.config.credentials && !this.refreshing) {
			const parsedUrl = url.parse(requestUrl);

			const opts = {
				region: this.config.region,
				service: 'execute-api',
				method: request.method,
				host: parsedUrl.host,
				path: parsedUrl.path,
				headers
			};

			// Sign the request
			aws4.sign(opts, AWS.config.credentials);

			// Copy over the headers
			headers = opts.headers;
		}

		let httpHeaders = new HttpHeaders(headers);

		// Setting a `host` header is being refused because it's unsafe. So let's just drop it.
		httpHeaders = httpHeaders.delete('host');

		request = request.clone({
			url: requestUrl,
			headers: httpHeaders
		});

		return next.handle(request);
	}
}
