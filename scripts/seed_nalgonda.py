#!/usr/bin/env python3
"""Seed a Nalgonda dairy: 100 customers across four real towns, 2 drivers.

Deliberately creates NO service areas — the point is to land on the
"it looks like you already deliver to these places" flow and exercise
setting them up, including the second-town case.
"""
import json, random, sys, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8087"
random.seed(20260829)  # same layout every run

def call(path, body=None, token=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method or ("POST" if body is not None else "GET"),
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or "{}")

token = call("/api/v1/auth/dev-login", method="POST")["token"]

# Real towns around Nalgonda, with the streets an address would actually
# name. Counts add up to 100 and are weighted like a real round: a home
# town that dominates, plus outlying towns worth their own service area.
TOWNS = [
    ("Nalgonda",    17.0575, 79.2671, 52, ["Clock Tower", "Prakasham Bazar", "NG College Road",
                                           "Ramgiri", "Vidya Nagar", "Panagal Road"]),
    ("Miryalaguda", 16.8721, 79.5644, 24, ["Bazar Street", "Ramalayam Road", "Anasagar",
                                           "Gandhi Chowk"]),
    ("Kodad",       16.9977, 79.9634, 15, ["Main Road", "Bus Stand Road", "Kothapeta"]),
    ("Suryapet",    17.1353, 79.6216,  9, ["Nehru Road", "Sivalayam Street", "Bypass Road"]),
]

FIRST = ["Anitha","Ravi","Srinivas","Lakshmi","Venkat","Padma","Ramesh","Sunitha","Kiran","Manjula",
         "Naveen","Swapna","Prasad","Rajitha","Mahesh","Sarita","Krishna","Vani","Suresh","Divya",
         "Ganesh","Bhavani","Rajesh","Kavitha","Arun","Sridevi","Mohan","Yadamma","Praveen","Latha"]
LAST = ["Reddy","Rao","Naidu","Sharma","Goud","Yadav","Kumar","Prasad","Chary","Varma"]

products = {p["name"]: p["id"] for p in call("/api/v1/products", token=token)["products"]}
milk1l  = products.get("Milk 1L")
milk500 = products.get("Milk 500ml")
curd    = products.get("Curd 500g")
EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

call("/api/v1/business", {"name": "Nalgonda Dairy", "home_lat": 17.0575, "home_lng": 79.2671},
     token=token, method="PATCH")

made = 0
for town, lat, lng, count, streets in TOWNS:
    for i in range(count):
        # ~1.8km spread: tight enough that each town clusters on its own,
        # far enough apart that they never merge into one suggestion.
        clat = lat + random.uniform(-0.016, 0.016)
        clng = lng + random.uniform(-0.016, 0.016)
        name = f"{random.choice(FIRST)} {random.choice(LAST)}"
        cust = call("/api/v1/customers", {
            "name": name,
            "phone": f"9{random.randint(100000000, 999999999)}",
            "address": f"{random.randint(1, 180)}, {random.choice(streets)}, {town}",
            "lat": round(clat, 6), "lng": round(clng, 6),
        }, token=token)

        # Most take milk daily; some take two things. A handful take
        # nothing yet, which is a real state worth having on screen.
        roll = random.random()
        if roll < 0.08:
            pass
        else:
            call("/api/v1/recurring-orders", {
                "customer_id": cust["id"], "product_id": milk1l if roll < 0.75 else milk500,
                "quantity": random.choice([1, 1, 1, 2, 2, 3]), "weekdays": EVERY_DAY,
            }, token=token)
            if roll > 0.70 and curd:
                call("/api/v1/recurring-orders", {
                    "customer_id": cust["id"], "product_id": curd,
                    "quantity": 1, "weekdays": EVERY_DAY,
                }, token=token)
        made += 1

# Two drivers, living at opposite ends so a split has an obvious answer.
for dname, phone, pin, hlat, hlng in [
    ("Ravi Kumar",     "9440011221", "481920", 17.0410, 79.2405),
    ("Srinivas Reddy", "9440011222", "481921", 17.0702, 79.2960),
]:
    d = call("/api/v1/drivers", {"name": dname, "phone": phone, "pin": pin}, token=token)
    call(f"/api/v1/drivers/{d['id']}/home", {"home_lat": hlat, "home_lng": hlng}, token=token)

day = call("/api/v1/day", token=token)
print(f"seeded {made} customers, 2 drivers")
print(f"  deliveries today: {day['summary'].get('total', 0)}")
print(f"  service areas: none on purpose — suggestions:")
for s in call("/api/v1/service-areas/suggest", token=token)["suggestions"]:
    print(f"    {s['name'] or '(unnamed)'}: {s['customer_count']} customers, "
          f"{s['radius_meters']/1000:.1f} km")
