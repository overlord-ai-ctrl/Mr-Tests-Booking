# Mr Tests Booking

Driving test booking portal with admin interface.

## Admin (Service)

- **URL**: https://<your-admin-api>/admin
- **Usage**: Enter admin token, Load centres, Append new centres
- **Flow**: Changes commit to GitHub → redeploys static site automatically

## Development

### Static Site
- `index.html` - Homepage
- `change-booking/index.html` - Booking form
- `track/index.html` - Tracking page
- `assets/` - Styles and assets

### Admin API
- `admin-api/server.js` - Express server
- `admin-api/public/` - Admin UI files
- `data/test_centres.json` - Test centres data

## Environment Variables (Admin API)

Required for admin-api service:
- `GITHUB_TOKEN` - GitHub personal access token
- `REPO_OWNER` - GitHub repository owner
- `REPO_NAME` - GitHub repository name
- `ADMIN_TOKEN` - Admin authentication token
- `CORS_ORIGIN` - Optional CORS origin
